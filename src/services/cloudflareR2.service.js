/**
 * services/cloudflareR2.service.js
 * High-performance storage client for Cloudflare R2 (S3-compatible)
 * Zero egress fees for OTA firmware binary distribution.
 */
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const crypto = require("crypto");

class CloudflareR2Service {
  constructor() {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

    this.bucketName = process.env.R2_BUCKET_NAME || "justride-ota";
    this.publicDomain = process.env.R2_PUBLIC_DOMAIN || `https://${this.bucketName}.r2.dev`;

    if (accountId && accessKeyId && secretAccessKey) {
      this.client = new S3Client({
        region: "auto",
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
      this.isConfigured = true;
    } else {
      this.isConfigured = false;
      this.client = null;
    }
  }

  /**
   * Upload a firmware .bin file to Cloudflare R2
   * @param {Buffer} fileBuffer Binary buffer of the compiled firmware
   * @param {string} fileName Destination key (e.g. "firmware/v2.2.0-justride-v1.bin")
   * @returns {Promise<{ url: string, sha256: string, size: number }>}
   */
  async uploadFirmware(fileBuffer, fileName) {
    // 1. Calculate SHA-256 Checksum
    const hash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
    const size = fileBuffer.length;

    if (!this.isConfigured) {
      // Fallback local mock URL if R2 credentials are not yet populated in .env
      return {
        url: `${this.publicDomain}/${fileName}`,
        sha256: hash,
        size,
      };
    }

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: fileName,
      Body: fileBuffer,
      ContentType: "application/octet-stream",
    });

    await this.client.send(command);

    return {
      url: `${this.publicDomain}/${fileName}`,
      sha256: hash,
      size,
    };
  }

  /**
   * Upload an Android APK or iOS package to Cloudflare R2
   * @param {Buffer} fileBuffer Binary buffer of the compiled APK
   * @param {string} fileName Destination key (e.g. "apk/v2.2.0-justride-release.apk")
   * @returns {Promise<{ url: string, sha256: string, size: number }>}
   */
  async uploadApk(fileBuffer, fileName) {
    const hash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
    const size = fileBuffer.length;

    if (!this.isConfigured) {
      return {
        url: `${this.publicDomain}/${fileName}`,
        sha256: hash,
        size,
      };
    }

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: fileName,
      Body: fileBuffer,
      ContentType: "application/vnd.android.package-archive",
    });

    await this.client.send(command);

    return {
      url: `${this.publicDomain}/${fileName}`,
      sha256: hash,
      size,
    };
  }

  /**
   * Delete firmware or APK binary from R2
   * @param {string} fileName Key to delete
   */
  async deleteFirmware(fileName) {
    if (!this.isConfigured) return;
    const command = new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: fileName,
    });
    await this.client.send(command);
  }
}

module.exports = new CloudflareR2Service();
