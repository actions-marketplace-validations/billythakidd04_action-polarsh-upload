import * as core from '@actions/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
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

export async function run(): Promise<void> {
  let fileName = '';
  let organizationId = '';
  let benefitId = '';

  try {
    const accessToken = core.getInput('access-token', { required: true });
    const filePath = core.getInput('file-path', { required: true });
    organizationId = core.getInput('organization-id');
    benefitId = core.getInput('benefit-id');
    const customFileName = core.getInput('file-name');
    const mimeType = core.getInput('mime-type') || 'application/zip';

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

    // Step 1: Resolve organization ID if not explicitly provided
    if (!organizationId) {
      core.info('Resolving default Polar organization from access token...');
      organizationId = await resolveOrganizationId({ accessToken });
      core.info(`Resolved Polar organization ID: ${organizationId}`);
    } else {
      core.info(`Target Polar organization ID: ${organizationId}`);
    }

    // Step 2: Initialize downloadable file and obtain presigned upload parts
    core.info('Creating downloadable file record on Polar.sh...');
    const createdFile = await createFile({
      accessToken,
      organizationId,
      fileName,
      fileSize,
      mimeType
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

    // Step 3: Upload chunks to presigned S3 URLs
    const completedParts: PolarCompletedPart[] = [];
    const fileDescriptor = fs.openSync(resolvedPath, 'r');

    try {
      const parts = createdFile.upload.parts;
      const partCount = parts.length;
      const partSize = Math.ceil(fileSize / partCount);

      for (let i = 0; i < partCount; i++) {
        const partInfo = parts[i];
        const offset = i * partSize;
        const currentChunkSize = Math.min(partSize, fileSize - offset);

        core.info(`Uploading part ${partInfo.number}/${partCount} (${formatBytes(currentChunkSize)})...`);
        const buffer = Buffer.alloc(currentChunkSize);
        fs.readSync(fileDescriptor, buffer, 0, currentChunkSize, offset);

        const uploadedPart = await uploadPart({
          presignedUrl: partInfo.url,
          partNumber: partInfo.number,
          buffer
        });

        completedParts.push(uploadedPart);
      }
    } finally {
      fs.closeSync(fileDescriptor);
    }

    // Step 4: Finalize file upload
    core.info('Finalizing downloadable file upload on Polar.sh...');
    const finalized = await completeFileUpload({
      accessToken,
      fileId: createdFile.id,
      filePath: createdFile.path,
      parts: completedParts
    });

    core.info(`File upload finalized. Path: ${finalized.path || createdFile.path}`);

    // Step 5: Attach file to downloadables benefit if benefit-id provided
    if (benefitId) {
      core.info(`Attaching file ${createdFile.id} to Polar benefit ${benefitId}...`);
      await attachFileToBenefit({
        accessToken,
        benefitId,
        fileId: createdFile.id
      });
      core.info(`Successfully linked file to Polar benefit ${benefitId}!`);
    }

    // Step 6: Set action outputs & write summary
    core.setOutput('file-id', createdFile.id);
    core.setOutput('file-path', finalized.path || createdFile.path);

    const summaryItems = [
      `**Organization ID**: \`${organizationId}\``,
      `**File**: \`${fileName}\` (${formatBytes(fileSize)})`,
      `**File ID**: \`${createdFile.id}\``,
      `**Storage Path**: \`${finalized.path || createdFile.path}\``
    ];

    if (benefitId) {
      summaryItems.push(`**Linked Benefit ID**: \`${benefitId}\``);
    }

    core.summary.addHeading('🐻‍❄️ Polar.sh Upload: Successful', 3).addList(summaryItems);
    await core.summary.write();

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
