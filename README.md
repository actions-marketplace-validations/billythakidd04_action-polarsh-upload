# Polar.sh File Upload GitHub Action

A standalone GitHub Action to upload release archives to Polar.sh and automatically attach them to digital product download benefits.

## Features

- **Automated S3 Multipart Upload**: Registers the file record with Polar.sh, streams binary chunks to presigned S3 URLs, and finalizes the upload.
- **Benefit Linking**: Automatically links uploaded release files to target digital download benefits (`type: downloadables`).
- **Organization Auto-Discovery**: Automatically resolves your default Polar organization ID from your Organization Access Token if omitted.
- **Immediate Step Summaries**: Writes markdown summaries directly to `$GITHUB_STEP_SUMMARY`.
- **Standalone Distribution**: Bundled into a self-contained runtime artifact using `@vercel/ncc`.

## Usage

```yaml
- name: Upload Release Archive to Polar.sh
  uses: billythakidd04/action-polarsh-upload@v0
  with:
    access-token: ${{ secrets.POLAR_ACCESS_TOKEN }}
    file-path: 'dist/go-saas-starter-v0.1.0.zip'
    organization-id: ${{ secrets.POLAR_ORGANIZATION_ID }} # Optional: auto-resolved if omitted
    benefit-id: ${{ secrets.POLAR_BENEFIT_ID }}           # Optional: attach to downloadable benefit
```

## Inputs

| Input | Description | Required | Default |
|---|---|---|---|
| `access-token` | Polar Organization Access Token (OAT) | Yes | |
| `file-path` | Path to the local release archive or file on disk | Yes | |
| `organization-id` | Polar organization ID | No | Auto-resolved from token |
| `benefit-id` | Polar downloadables benefit ID to link the file | No | |
| `file-name` | Custom display file name on Polar | No | Basename of `file-path` |
| `mime-type` | MIME type of the file | No | `application/zip` |

## Outputs

| Output | Description |
|---|---|
| `file-id` | Polar internal file ID |
| `file-path` | Polar internal storage path of the file |

## Local Development

```bash
# Install dependencies
npm ci

# Run test suite
npm test

# Build bundled action distribution
npm run build
```

## License

MIT
