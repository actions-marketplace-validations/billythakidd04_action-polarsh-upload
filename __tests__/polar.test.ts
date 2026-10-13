import {
  resolveOrganizationId,
  createFile,
  uploadPart,
  completeFileUpload,
  attachFileToBenefit
} from '../src/polar';
import { formatBytes } from '../src/index';

describe('formatBytes', () => {
  it('formats 0 bytes correctly', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats KB, MB, and GB accurately', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1048576)).toBe('1 MB');
    expect(formatBytes(5242880)).toBe('5 MB');
    expect(formatBytes(1073741824)).toBe('1 GB');
  });
});

describe('Polar API Client', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('resolveOrganizationId', () => {
    it('returns first organization ID on success', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ id: 'org_123', name: 'My Org', slug: 'my-org' }]
        })
      } as Response);

      const orgId = await resolveOrganizationId({ accessToken: 'polar_tok' });
      expect(orgId).toBe('org_123');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.polar.sh/v1/organizations',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer polar_tok'
          })
        })
      );
    });

    it('throws error when HTTP status is not ok', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Invalid token'
      } as Response);

      await expect(
        resolveOrganizationId({ accessToken: 'bad_token', apiBase: 'https://api.test' })
      ).rejects.toThrow('Failed to resolve Polar organization (HTTP 401): Invalid token');
    });

    it('throws error when organizations array is empty', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ items: [] })
      } as Response);

      await expect(
        resolveOrganizationId({ accessToken: 'polar_tok', apiBase: 'https://api.test' })
      ).rejects.toThrow('No Polar organizations found for the provided access token.');
    });
  });

  describe('createFile', () => {
    it('creates file record with default mimeType', async () => {
      const mockResponse = {
        id: 'file_abc',
        organization_id: 'org_123',
        name: 'release.zip',
        path: '/downloadables/release.zip',
        mime_type: 'application/zip',
        size: 2048,
        service: 'downloadable',
        upload: {
          parts: [{ number: 1, url: 'https://s3.test/upload-part-1' }]
        }
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockResponse
      } as Response);

      const result = await createFile({
        accessToken: 'tok',
        organizationId: 'org_123',
        fileName: 'release.zip',
        fileSize: 2048
      });

      expect(result).toEqual(mockResponse);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.polar.sh/v1/files',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            organization_id: 'org_123',
            name: 'release.zip',
            mime_type: 'application/zip',
            size: 2048,
            service: 'downloadable',
            upload: {
              parts: [{ number: 1, chunk_start: 0, chunk_end: 2048 }]
            }
          })
        })
      );
    });

    it('throws error when file creation HTTP status is not ok', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Invalid payload'
      } as Response);

      await expect(
        createFile({
          accessToken: 'tok',
          organizationId: 'org_1',
          fileName: 'f.zip',
          fileSize: 10,
          apiBase: 'https://api.test'
        })
      ).rejects.toThrow('Polar file creation failed (HTTP 400): Invalid payload');
    });
  });

  describe('uploadPart', () => {
    it('uploads chunk and extracts lowercase etag', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name.toLowerCase() === 'etag' ? '"etag-polar-123"' : null)
        }
      } as unknown as Response);

      const result = await uploadPart({
        presignedUrl: 'https://s3.test/chunk',
        partNumber: 1,
        buffer: Buffer.from('chunk')
      });

      expect(result).toEqual({
        number: 1,
        checksum_etag: 'etag-polar-123'
      });
    });

    it('uploads chunk and extracts uppercase ETag', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'ETag' ? '"ETAG-UPPER"' : null)
        }
      } as unknown as Response);

      const result = await uploadPart({
        presignedUrl: 'https://s3.test/chunk',
        partNumber: 2,
        buffer: Buffer.from('chunk 2')
      });

      expect(result).toEqual({
        number: 2,
        checksum_etag: 'ETAG-UPPER'
      });
    });

    it('falls back to partNumber string if etag is missing', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: {
          get: () => null
        }
      } as unknown as Response);

      const result = await uploadPart({
        presignedUrl: 'https://s3.test/chunk',
        partNumber: 3,
        buffer: Buffer.from('chunk 3')
      });

      expect(result).toEqual({
        number: 3,
        checksum_etag: '3'
      });
    });

    it('throws error when upload part fails', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'S3 upload error'
      } as Response);

      await expect(
        uploadPart({
          presignedUrl: 'https://s3.test/chunk',
          partNumber: 1,
          buffer: Buffer.from('chunk')
        })
      ).rejects.toThrow('Polar chunk upload failed for part 1 (HTTP 500): S3 upload error');
    });
  });

  describe('completeFileUpload', () => {
    it('finalizes upload and returns completed file record', async () => {
      const mockResponse = {
        id: 'file_1',
        organization_id: 'org_1',
        name: 'release.zip',
        path: '/downloadables/release.zip',
        mime_type: 'application/zip',
        size: 1024,
        service: 'downloadable',
        upload: { parts: [] }
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockResponse
      } as Response);

      const result = await completeFileUpload({
        accessToken: 'tok',
        fileId: 'file_1',
        filePath: '/downloadables/release.zip',
        parts: [{ number: 1, checksum_etag: 'etag1' }]
      });

      expect(result).toEqual(mockResponse);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.polar.sh/v1/files/file_1/uploaded',
        expect.objectContaining({
          method: 'POST'
        })
      );
    });

    it('throws error when complete request fails', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'File already finalized'
      } as Response);

      await expect(
        completeFileUpload({
          accessToken: 'tok',
          fileId: 'f',
          filePath: '/p',
          parts: [],
          apiBase: 'https://api.test'
        })
      ).rejects.toThrow('Polar complete upload failed (HTTP 400): File already finalized');
    });
  });

  describe('attachFileToBenefit', () => {
    it('appends fileId to benefit files avoiding duplicates', async () => {
      const mockGet = {
        id: 'ben_1',
        type: 'downloadables',
        description: 'Starter download',
        properties: {
          files: ['existing_file_1']
        }
      };

      const mockPatch = {
        id: 'ben_1',
        type: 'downloadables',
        description: 'Starter download',
        properties: {
          files: ['existing_file_1', 'file_2']
        }
      };

      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => mockGet
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => mockPatch
        } as Response);

      const result = await attachFileToBenefit({
        accessToken: 'tok',
        benefitId: 'ben_1',
        fileId: 'file_2'
      });

      expect(result).toEqual(mockPatch);
      expect(global.fetch).toHaveBeenNthCalledWith(
        2,
        'https://api.polar.sh/v1/benefits/ben_1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({
            type: 'downloadables',
            properties: {
              files: ['existing_file_1', 'file_2']
            }
          })
        })
      );
    });

    it('attaches fileId when benefit had no prior files array', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 404
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'ben_1', type: 'downloadables', properties: { files: ['new_f'] } })
        } as Response);

      const result = await attachFileToBenefit({
        accessToken: 'tok',
        benefitId: 'ben_1',
        fileId: 'new_f',
        apiBase: 'https://api.test'
      });

      expect(result.properties?.files).toEqual(['new_f']);
    });

    it('throws error when benefit patch fails', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'b' })
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
          text: async () => 'Forbidden benefit'
        } as Response);

      await expect(
        attachFileToBenefit({
          accessToken: 'tok',
          benefitId: 'b',
          fileId: 'f',
          apiBase: 'https://api.test'
        })
      ).rejects.toThrow('Polar attach to benefit failed (HTTP 403): Forbidden benefit');
    });
  });
});
