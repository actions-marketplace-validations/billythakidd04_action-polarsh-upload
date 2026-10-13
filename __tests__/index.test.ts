import * as core from '@actions/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { run } from '../src/index';
import * as polar from '../src/polar';

jest.mock('@actions/core');
jest.mock('../src/polar');

describe('Polar Action run() Entrypoint', () => {
  const tmpDir = path.join(__dirname, 'tmp');
  const testFile = path.join(tmpDir, 'test-asset.zip');

  beforeAll(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    fs.writeFileSync(testFile, 'dummy zip content for testing polar action');
  });

  afterAll(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();

    (core.getInput as jest.Mock).mockImplementation((name: string) => {
      switch (name) {
        case 'access-token':
          return 'polar_oat_secret';
        case 'file-path':
          return testFile;
        case 'organization-id':
          return 'org_explicit_123';
        case 'benefit-id':
          return 'ben_456';
        case 'file-name':
          return 'custom-release.zip';
        case 'mime-type':
          return 'application/zip';
        default:
          return '';
      }
    });

    const summaryMock = {
      addHeading: jest.fn().mockReturnThis(),
      addList: jest.fn().mockReturnThis(),
      addRaw: jest.fn().mockReturnThis(),
      write: jest.fn().mockResolvedValue(undefined)
    };
    (core as unknown as { summary: typeof summaryMock }).summary = summaryMock;
  });

  it('runs full upload lifecycle successfully with explicit organization and benefit IDs', async () => {
    (polar.createFile as jest.Mock).mockResolvedValue({
      id: 'file_polar_1',
      path: '/downloadables/custom-release.zip',
      upload: {
        parts: [{ number: 1, url: 'https://s3.test/upload' }]
      }
    });

    (polar.uploadPart as jest.Mock).mockResolvedValue({
      number: 1,
      checksum_etag: 'etag_123'
    });

    (polar.completeFileUpload as jest.Mock).mockResolvedValue({
      id: 'file_polar_1',
      path: '/downloadables/custom-release.zip'
    });

    (polar.attachFileToBenefit as jest.Mock).mockResolvedValue({
      id: 'ben_456',
      type: 'downloadables'
    });

    await run();

    expect(polar.resolveOrganizationId).not.toHaveBeenCalled();
    expect(polar.createFile).toHaveBeenCalledWith({
      accessToken: 'polar_oat_secret',
      organizationId: 'org_explicit_123',
      fileName: 'custom-release.zip',
      fileSize: expect.any(Number),
      mimeType: 'application/zip'
    });

    expect(polar.uploadPart).toHaveBeenCalledWith({
      presignedUrl: 'https://s3.test/upload',
      partNumber: 1,
      buffer: expect.any(Buffer)
    });

    expect(polar.completeFileUpload).toHaveBeenCalledWith({
      accessToken: 'polar_oat_secret',
      fileId: 'file_polar_1',
      filePath: '/downloadables/custom-release.zip',
      parts: [{ number: 1, checksum_etag: 'etag_123' }]
    });

    expect(polar.attachFileToBenefit).toHaveBeenCalledWith({
      accessToken: 'polar_oat_secret',
      benefitId: 'ben_456',
      fileId: 'file_polar_1'
    });

    expect(core.setOutput).toHaveBeenCalledWith('file-id', 'file_polar_1');
    expect(core.setOutput).toHaveBeenCalledWith('file-path', '/downloadables/custom-release.zip');
    expect(core.summary.write).toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('resolves organization ID automatically when organization-id is omitted', async () => {
    (core.getInput as jest.Mock).mockImplementation((name: string) => {
      switch (name) {
        case 'access-token':
          return 'polar_oat_secret';
        case 'file-path':
          return testFile;
        case 'organization-id':
          return '';
        case 'benefit-id':
          return '';
        case 'file-name':
          return '';
        default:
          return '';
      }
    });

    (polar.resolveOrganizationId as jest.Mock).mockResolvedValue('org_auto_resolved');
    (polar.createFile as jest.Mock).mockResolvedValue({
      id: 'file_polar_2',
      path: '/downloadables/test-asset.zip',
      upload: {
        parts: [{ number: 1, url: 'https://s3.test/upload' }]
      }
    });
    (polar.uploadPart as jest.Mock).mockResolvedValue({
      number: 1,
      checksum_etag: 'etag_2'
    });
    (polar.completeFileUpload as jest.Mock).mockResolvedValue({
      id: 'file_polar_2',
      path: '/downloadables/test-asset.zip'
    });

    await run();

    expect(polar.resolveOrganizationId).toHaveBeenCalledWith({ accessToken: 'polar_oat_secret' });
    expect(polar.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_auto_resolved',
        fileName: 'test-asset.zip'
      })
    );
    expect(polar.attachFileToBenefit).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('file-id', 'file_polar_2');
  });

  it('fails cleanly when specified file-path does not exist', async () => {
    (core.getInput as jest.Mock).mockImplementation((name: string) => {
      if (name === 'file-path') return path.join(tmpDir, 'missing.zip');
      return 'val';
    });

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Specified file-path does not exist'));
  });

  it('fails cleanly when specified file-path is a directory', async () => {
    (core.getInput as jest.Mock).mockImplementation((name: string) => {
      if (name === 'file-path') return tmpDir;
      return 'val';
    });

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Specified file-path is not a file'));
  });

  it('fails cleanly when createFile returns missing upload parts', async () => {
    (polar.createFile as jest.Mock).mockResolvedValue({
      id: 'file_missing_parts',
      path: '/p',
      upload: { parts: [] }
    });

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      'Polar.sh file creation did not return valid upload credentials or parts.'
    );
  });

  it('fails cleanly when non-Error object is thrown', async () => {
    (polar.createFile as jest.Mock).mockRejectedValue('String error from polar');

    await run();

    expect(core.setFailed).toHaveBeenCalledWith('String error from polar');
  });

  it('handles summary write rejection gracefully', async () => {
    const brokenSummary = {
      addHeading: jest.fn().mockReturnThis(),
      addList: jest.fn().mockReturnThis(),
      addRaw: jest.fn().mockReturnThis(),
      write: jest.fn().mockRejectedValue(new Error('Buffer failure'))
    };
    (core as unknown as { summary: typeof brokenSummary }).summary = brokenSummary;

    (polar.createFile as jest.Mock).mockRejectedValue(new Error('API failure'));

    await run();

    expect(core.setFailed).toHaveBeenCalledWith('API failure');
  });
});
