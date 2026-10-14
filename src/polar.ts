export interface PolarOrganization {
  id: string;
  name: string;
  slug: string;
}

export interface PolarFilePart {
  number: number;
  url: string;
  chunk_start?: number;
  chunk_end?: number;
  headers?: Record<string, string>;
}

export interface PolarFileCreateResponse {
  id: string;
  organization_id: string;
  name: string;
  path: string;
  mime_type: string;
  size: number;
  service: string;
  upload: {
    id: string;
    path: string;
    parts: PolarFilePart[];
  };
}

export interface PolarCompletedPart {
  number: number;
  checksum_etag: string;
  checksum_sha256_base64?: string;
}

export interface PolarBenefitResponse {
  id: string;
  type: string;
  description: string;
  properties?: {
    files?: string[];
    [key: string]: unknown;
  };
}

export const POLAR_API_PRODUCTION = 'https://api.polar.sh/v1';
export const POLAR_API_SANDBOX = 'https://sandbox-api.polar.sh/v1';

export function resolveApiBase(options?: { server?: string; apiBase?: string }): string {
  if (options?.apiBase && options.apiBase.trim().length > 0) {
    return options.apiBase.trim().replace(/\/+$/, '');
  }
  if (options?.server?.trim().toLowerCase() === 'sandbox') {
    return POLAR_API_SANDBOX;
  }
  return POLAR_API_PRODUCTION;
}

export async function resolveOrganizationId(options: {
  accessToken: string;
  apiBase?: string;
}): Promise<string> {
  const { accessToken, apiBase = POLAR_API_PRODUCTION } = options;
  const endpoint = `${apiBase}/organizations`;

  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to resolve Polar organization (HTTP ${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as { items?: PolarOrganization[]; [key: string]: unknown };
  const orgs = Array.isArray(data.items) ? data.items : [];
  if (orgs.length === 0 || !orgs[0].id) {
    throw new Error('No Polar organizations found for the provided access token.');
  }

  return orgs[0].id;
}

export async function createFile(options: {
  accessToken: string;
  organizationId?: string;
  fileName: string;
  fileSize: number;
  mimeType?: string;
  apiBase?: string;
  sha256Base64?: string;
}): Promise<PolarFileCreateResponse> {
  const {
    accessToken,
    organizationId,
    fileName,
    fileSize,
    mimeType = 'application/zip',
    apiBase = POLAR_API_PRODUCTION,
    sha256Base64
  } = options;
  const endpoint = `${apiBase}/files`;

  const part: Record<string, unknown> = {
    number: 1,
    chunk_start: 0,
    chunk_end: fileSize
  };
  if (sha256Base64) {
    part.checksum_sha256_base64 = sha256Base64;
  }

  const body: Record<string, unknown> = {
    name: fileName,
    mime_type: mimeType,
    size: fileSize,
    service: 'downloadable',
    upload: {
      parts: [part]
    }
  };

  // Polar API rejects organization_id when an Organization Access Token (polar_oat_*) is used.
  if (organizationId && !accessToken.startsWith('polar_oat_')) {
    body.organization_id = organizationId;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Polar file creation failed (HTTP ${response.status}): ${errorText}`);
  }

  return (await response.json()) as PolarFileCreateResponse;
}

export async function uploadPart(options: {
  presignedUrl: string;
  partNumber: number;
  buffer: Buffer | Uint8Array;
  headers?: Record<string, string>;
  sha256Base64?: string;
}): Promise<PolarCompletedPart> {
  const { presignedUrl, partNumber, buffer, headers = {}, sha256Base64 } = options;

  const response = await fetch(presignedUrl, {
    method: 'PUT',
    headers,
    body: buffer
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Polar chunk upload failed for part ${partNumber} (HTTP ${response.status}): ${errorText}`);
  }

  const rawEtag = response.headers.get('etag') || response.headers.get('ETag') || `"${partNumber}"`;

  const completed: PolarCompletedPart = {
    number: partNumber,
    checksum_etag: rawEtag
  };
  if (sha256Base64) {
    completed.checksum_sha256_base64 = sha256Base64;
  }

  return completed;
}

export async function completeFileUpload(options: {
  accessToken: string;
  fileId: string;
  uploadId: string;
  filePath: string;
  parts: PolarCompletedPart[];
  apiBase?: string;
}): Promise<PolarFileCreateResponse> {
  const { accessToken, fileId, uploadId, filePath, parts, apiBase = POLAR_API_PRODUCTION } = options;
  const endpoint = `${apiBase}/files/${encodeURIComponent(fileId)}/uploaded`;

  const body = {
    id: uploadId,
    path: filePath,
    parts
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Polar complete upload failed (HTTP ${response.status}): ${errorText}`);
  }

  return (await response.json()) as PolarFileCreateResponse;
}

export async function attachFileToBenefit(options: {
  accessToken: string;
  benefitId: string;
  fileId: string;
  apiBase?: string;
}): Promise<PolarBenefitResponse> {
  const { accessToken, benefitId, fileId, apiBase = POLAR_API_PRODUCTION } = options;

  // 1. Fetch current benefit to retain existing attached files
  const getEndpoint = `${apiBase}/benefits/${encodeURIComponent(benefitId)}`;
  const getRes = await fetch(getEndpoint, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    }
  });

  let existingFiles: string[] = [];
  if (getRes.ok) {
    const benefitData = (await getRes.json()) as PolarBenefitResponse;
    if (benefitData.properties?.files && Array.isArray(benefitData.properties.files)) {
      existingFiles = benefitData.properties.files;
    }
  }

  const updatedFiles = Array.from(new Set([...existingFiles, fileId]));

  // 2. Patch benefit with new list of files
  const patchEndpoint = `${apiBase}/benefits/${encodeURIComponent(benefitId)}`;
  const patchRes = await fetch(patchEndpoint, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      type: 'downloadables',
      properties: {
        files: updatedFiles
      }
    })
  });

  if (!patchRes.ok) {
    const errorText = await patchRes.text();
    throw new Error(`Polar attach to benefit failed (HTTP ${patchRes.status}): ${errorText}`);
  }

  return (await patchRes.json()) as PolarBenefitResponse;
}
