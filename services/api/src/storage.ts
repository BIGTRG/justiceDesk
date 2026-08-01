/**
 * The document vault.
 *
 * Non-negotiable #1: "Documents never leave MinIO except via the authenticated user's own
 * signed-URL download/print; every view/download in audit_log."
 *
 * That invariant is enforced here structurally, not by convention:
 *   * There is no route that streams document bytes through the API. The only way out is
 *     a signed URL.
 *   * `issueSignedUrl` takes an audit callback and awaits it BEFORE minting the URL. A
 *     failed audit write means no URL. There is no code path that mints one without
 *     logging, because minting is not exposed separately.
 */

import { HttpError } from '@justicedesk/service-kit'
import { Client as MinioClient } from 'minio'
import type { ApiConfig } from './config.js'

export interface Vault {
  ensureBucket(): Promise<void>
  putObject(key: string, body: Buffer, contentType: string): Promise<{ etag: string; size: number }>
  getObject(key: string): Promise<Buffer>
  /** Mint a short-lived download URL. The audit write happens first and must succeed. */
  issueSignedUrl(key: string, filename: string, audit: () => Promise<void>): Promise<string>
  removeObject(key: string): Promise<void>
}

export function createVault(config: ApiConfig): Vault {
  const client = new MinioClient({
    endPoint: config.minio.endPoint,
    port: config.minio.port,
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
  })
  const bucket = config.minio.bucket

  return {
    async ensureBucket() {
      if (!(await client.bucketExists(bucket))) {
        await client.makeBucket(bucket)
      }
    },

    async putObject(key, body, contentType) {
      const result = await client.putObject(bucket, key, body, body.length, {
        'Content-Type': contentType,
      })
      return { etag: result.etag, size: body.length }
    },

    async getObject(key) {
      const stream = await client.getObject(bucket, key)
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(chunk as Buffer)
      return Buffer.concat(chunks)
    },

    async issueSignedUrl(key, filename, audit) {
      // Audit first. If this throws, no URL is minted and the document stays in the vault.
      await audit()

      try {
        return await client.presignedGetObject(bucket, key, config.minio.signedUrlTtlSeconds, {
          // Force a download with a readable name rather than the opaque object key.
          'response-content-disposition': `attachment; filename="${sanitizeFilename(filename)}"`,
        })
      } catch (err) {
        throw new HttpError(
          503,
          'vault_unavailable',
          'We could not prepare that document for download. Please try again.',
          { cause: (err as Error).message }
        )
      }
    },

    async removeObject(key) {
      await client.removeObject(bucket, key)
    },
  }
}

/** Strip anything that could break the Content-Disposition header or traverse a path. */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\r\n"\\]/g, '')
    .replace(/[/\\]/g, '-')
    .replace(/\.{2,}/g, '.')
    .trim()
  return (cleaned.length ? cleaned : 'document').slice(0, 120)
}

/**
 * Object keys are namespaced by case so a leaked key reveals nothing about other cases,
 * and a per-case prefix makes deletion on account closure a single operation.
 */
export function documentKey(caseId: string, documentId: string, version: number): string {
  return `cases/${caseId}/documents/${documentId}/v${version}.pdf`
}
