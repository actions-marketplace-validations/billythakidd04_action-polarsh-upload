import * as core from '@actions/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { run, loadEnvFile, getActionInput } from '../src/index';
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
    delete process.env.INPUT_ACCESS_TOKEN;
    delete process.env.INPUT_FILE_PATH;
    delete process.env.INPUT_BENEFIT_ID;
    delete process.env.INPUT_ORGANIZATION_ID;
    delete process.env.POLAR_ACCESS_TOKEN;
    delete process.env.POLAR_BENEFIT_ID;
    delete process.env.POLAR_ORGANIZATION_ID;
    delete process.env.FILE_PATH;
    process.env.GITHUB_STEP_SUMMARY = '/tmp/test-summary.md';
    (polar.resolveApiBase as jest.Mock).mockReturnValue('https://api.polar.sh/v1');

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
        id: 's3_upload_123',
        path: '/downloadables/custom-release.zip',
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
      mimeType: 'application/zip',
      apiBase: expect.any(String),
      sha256Base64: expect.any(String)
    });

    expect(polar.uploadPart).toHaveBeenCalledWith({
      presignedUrl: 'https://s3.test/upload',
      partNumber: 1,
      buffer: expect.any(Buffer),
      headers: undefined,
      sha256Base64: expect.any(String)
    });

    expect(polar.completeFileUpload).toHaveBeenCalledWith({
      accessToken: 'polar_oat_secret',
      fileId: 'file_polar_1',
      uploadId: 's3_upload_123',
      filePath: '/downloadables/custom-release.zip',
      parts: expect.any(Array),
      apiBase: expect.any(String)
    });

    expect(polar.attachFileToBenefit).toHaveBeenCalledWith({
      accessToken: 'polar_oat_secret',
      benefitId: 'ben_456',
      fileId: 'file_polar_1',
      apiBase: expect.any(String)
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
        id: 's3_upload_auto',
        path: '/downloadables/test-asset.zip',
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

    expect(polar.resolveOrganizationId).toHaveBeenCalledWith({
      accessToken: 'polar_oat_secret',
      apiBase: expect.any(String)
    });
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

  describe('loadEnvFile helper', () => {
    it('parses valid key-value pairs and ignores comments and blanks', () => {
      const envPath = path.join(tmpDir, '.test-env');
      fs.writeFileSync(envPath, '# comment line\nTEST_KEY_ONE="value1"\nTEST_KEY_TWO=\'value2\'\nTEST_KEY_THREE=plain\n\n');

      loadEnvFile(envPath);

      expect(process.env.TEST_KEY_ONE).toBe('value1');
      expect(process.env.TEST_KEY_TWO).toBe('value2');
      expect(process.env.TEST_KEY_THREE).toBe('plain');

      delete process.env.TEST_KEY_ONE;
      delete process.env.TEST_KEY_TWO;
      delete process.env.TEST_KEY_THREE;
    });

    it('does nothing when env file does not exist', () => {
      expect(() => loadEnvFile(path.join(tmpDir, 'does-not-exist.env'))).not.toThrow();
    });
  });

  describe('getActionInput helper', () => {
    beforeEach(() => {
      (core.getInput as jest.Mock).mockReturnValue('');
    });

    it('falls back to uppercase INPUT_ env variable when core.getInput is empty', () => {
      process.env.INPUT_ACCESS_TOKEN = 'token_from_env';
      expect(getActionInput('access-token')).toBe('token_from_env');
      delete process.env.INPUT_ACCESS_TOKEN;
    });

    it('falls back to recognized alias variable', () => {
      process.env.POLAR_ACCESS_TOKEN = 'token_from_alias';
      expect(getActionInput('access-token')).toBe('token_from_alias');
      delete process.env.POLAR_ACCESS_TOKEN;
    });

    it('throws error when required input is missing', () => {
      expect(() => getActionInput('access-token', { required: true })).toThrow(
        'Input required and not supplied: access-token'
      );
    });
  });
});
