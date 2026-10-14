import * as core from '@actions/core';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  resolveApiBase,
  resolveOrganizationId,
  createFile,
  uploadPart,
  completeFileUpload,
  attachFileToBenefit,
  PolarCompletedPart
} from './polar';

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function loadEnvFile(envPath = '.env'): void {
  if (process.env.NODE_ENV === 'test' && envPath === '.env') return;
  const resolved = path.resolve(envPath);
  if (!fs.existsSync(resolved)) return;
  const content = fs.readFileSync(resolved, 'utf-8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

export function getActionInput(name: string, options?: { required?: boolean }): string {
  const fromCore = core.getInput(name);
  if (fromCore) return fromCore;

  const envKey = `INPUT_${name.replace(/[-\s]/g, '_').toUpperCase()}`;
  if (process.env[envKey]) return process.env[envKey]!.trim();

  const aliasMap: Record<string, string[]> = {
    'access-token': ['POLAR_ACCESS_TOKEN', 'POLAR_TOKEN'],
    'file-path': ['FILE_PATH', 'POLAR_FILE_PATH'],
    'benefit-id': ['POLAR_BENEFIT_ID'],
    'organization-id': ['POLAR_ORGANIZATION_ID'],
    'file-name': ['FILE_NAME', 'POLAR_FILE_NAME'],
    'mime-type': ['MIME_TYPE', 'POLAR_MIME_TYPE'],
    'server': ['POLAR_SERVER'],
    'api-base': ['POLAR_API_BASE']
  };

  const aliases = aliasMap[name] || [];
  for (const alias of aliases) {
    if (process.env[alias]) {
      return process.env[alias]!.trim();
    }
  }

  if (options?.required) {
    throw new Error(`Input required and not supplied: ${name}`);
  }
  return '';
}

export async function run(): Promise<void> {
  loadEnvFile();
  let fileName = '';
  let organizationId = '';
  let benefitId = '';

  try {
    const accessToken = getActionInput('access-token', { required: true });
    const filePath = getActionInput('file-path', { required: true });
    organizationId = getActionInput('organization-id');
    benefitId = getActionInput('benefit-id');
    const customFileName = getActionInput('file-name');
    const mimeType = getActionInput('mime-type') || 'application/zip';
    const server = getActionInput('server') || 'production';
    const customApiBase = getActionInput('api-base');
    const apiBase = resolveApiBase({ server, apiBase: customApiBase });

    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Specified file-path does not exist: ${resolvedPath}`);
    }

    const stats = fs.statSync(resolvedPath);
    if (!stats.isFile()) {
      throw new Error(`Specified file-path is not a file: ${resolvedPath}`);
    }

    const fileSize = stats.size;
    fileName = customFileName || path.basename(resolvedPath);

    core.info(`Preparing Polar.sh upload for file: ${fileName} (${formatBytes(fileSize)})`);
    core.info(`Target Polar API base: ${apiBase}`);

    // Step 1: Resolve organization ID if not explicitly provided
    if (!organizationId) {
      core.info('Resolving default Polar organization from access token...');
      organizationId = await resolveOrganizationId({ accessToken, apiBase });
      core.info(`Resolved Polar organization ID: ${organizationId}`);
    } else {
      core.info(`Target Polar organization ID: ${organizationId}`);
    }

    // Step 2: Initialize downloadable file and obtain presigned upload parts
    core.info('Computing file SHA-256 integrity checksum...');
    const fileBuffer = fs.readFileSync(resolvedPath);
    const sha256Base64 = crypto.createHash('sha256').update(fileBuffer).digest('base64');

    core.info('Creating downloadable file record on Polar.sh...');
    const createdFile = await createFile({
      accessToken,
      organizationId,
      fileName,
      fileSize,
      mimeType,
      apiBase,
      sha256Base64
    });

    if (
      !createdFile ||
      !createdFile.id ||
      !createdFile.upload ||
      !Array.isArray(createdFile.upload.parts) ||
      createdFile.upload.parts.length === 0
    ) {
      throw new Error('Polar.sh file creation did not return valid upload credentials or parts.');
    }

    core.info(`File record created. File ID: ${createdFile.id}, Parts: ${createdFile.upload.parts.length}`);

    // Step 3: Upload file parts to Polar presigned storage
    const completedParts: PolarCompletedPart[] = [];
    const parts = createdFile.upload.parts;

    for (let i = 0; i < parts.length; i++) {
      const partInfo = parts[i];
      core.info(`Uploading part ${partInfo.number}/${parts.length} to Polar storage...`);

      const uploadedPart = await uploadPart({
        presignedUrl: partInfo.url,
        partNumber: partInfo.number,
        buffer: fileBuffer,
        headers: partInfo.headers,
        sha256Base64
      });

      completedParts.push(uploadedPart);
    }

    // Step 4: Finalize file upload
    core.info('Finalizing downloadable file upload on Polar.sh...');
    const finalized = await completeFileUpload({
      accessToken,
      fileId: createdFile.id,
      uploadId: createdFile.upload.id,
      filePath: createdFile.path,
      parts: completedParts,
      apiBase
    });

    core.info(`File upload finalized. Path: ${finalized.path || createdFile.path}`);

    // Step 5: Attach file to downloadables benefit if benefit-id provided
    if (benefitId) {
      core.info(`Attaching file ${createdFile.id} to Polar benefit ${benefitId}...`);
      await attachFileToBenefit({
        accessToken,
        benefitId,
        fileId: createdFile.id,
        apiBase
      });
      core.info(`Successfully linked file to Polar benefit ${benefitId}!`);
    }

    // Step 6: Set action outputs & write summary
    core.setOutput('file-id', createdFile.id);
    core.setOutput('file-path', finalized.path || createdFile.path);

    const summaryItems = [
      `**Environment / API**: \`${apiBase}\``,
      `**Organization ID**: \`${organizationId}\``,
      `**File**: \`${fileName}\` (${formatBytes(fileSize)})`,
      `**File ID**: \`${createdFile.id}\``,
      `**Storage Path**: \`${finalized.path || createdFile.path}\``
    ];

    if (benefitId) {
      summaryItems.push(`**Linked Benefit ID**: \`${benefitId}\``);
    }

    if (process.env.GITHUB_STEP_SUMMARY) {
      core.summary.addHeading('🐻‍❄️ Polar.sh Upload: Successful', 3).addList(summaryItems);
      await core.summary.write();
    }

    core.info(`Successfully uploaded ${fileName} to Polar.sh!`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);

    try {
      core.summary
        .addHeading('❌ Polar.sh Upload: Failed', 3)
        .addRaw(`> ${message}\n\n`)
        .addList([
          `**Organization ID**: \`${organizationId || 'N/A'}\``,
          `**File**: \`${fileName || 'N/A'}\``
        ]);
      await core.summary.write();
    } catch {
      // Ignore summary write errors if summary buffer is unavailable
    }
  }
}

if (process.env.NODE_ENV !== 'test') {
  void run();
}
