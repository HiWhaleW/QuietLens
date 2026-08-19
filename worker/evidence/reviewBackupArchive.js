import Ajv from "ajv";

import { verifyEvidenceReviewAuditBackup } from "./reviewAuditLedger.js";

export const EVIDENCE_REVIEW_BACKUP_ARCHIVE_SCHEMA_VERSION = "1.0.0";
export const EVIDENCE_REVIEW_BACKUP_ARCHIVE_KDF_ITERATIONS = 310_000;

const dateTimePattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$";
const base64UrlPattern = "^[A-Za-z0-9_-]+$";
const hashPattern = "^[a-f0-9]{64}$";

const archiveSchema = {
  $id: "https://quietlens.local/schema/evidence-review-backup-archive-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EvidenceReviewBackupArchive",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "sealed_at",
    "cipher",
    "kdf",
    "kdf_iterations",
    "salt_base64url",
    "iv_base64url",
    "ciphertext_base64url",
    "ciphertext_sha256",
    "requires_human_restore",
    "automatic_apply_allowed",
  ],
  properties: {
    schema_version: { const: EVIDENCE_REVIEW_BACKUP_ARCHIVE_SCHEMA_VERSION },
    sealed_at: { type: "string", pattern: dateTimePattern },
    cipher: { const: "AES-256-GCM" },
    kdf: { const: "PBKDF2-HMAC-SHA256" },
    kdf_iterations: { const: EVIDENCE_REVIEW_BACKUP_ARCHIVE_KDF_ITERATIONS },
    salt_base64url: { type: "string", pattern: base64UrlPattern },
    iv_base64url: { type: "string", pattern: base64UrlPattern },
    ciphertext_base64url: { type: "string", pattern: base64UrlPattern },
    ciphertext_sha256: { type: "string", pattern: hashPattern },
    requires_human_restore: { const: true },
    automatic_apply_allowed: { const: false },
  },
};

const ajv = new Ajv({ allErrors: true, strict: true });
const validateArchive = ajv.compile(archiveSchema);

function cryptoApi() {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== "function") {
    throw new Error("EVIDENCE_REVIEW_BACKUP_ARCHIVE_CRYPTO_UNAVAILABLE");
  }
  return globalThis.crypto;
}

function assertPassphrase(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < 16 || passphrase.length > 1024) {
    throw new Error("EVIDENCE_REVIEW_BACKUP_ARCHIVE_PASSPHRASE_INVALID");
  }
  return passphrase;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256Hex(bytes) {
  const digest = await cryptoApi().subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function archiveMetadata(sealedAt, salt, iv) {
  return {
    schema_version: EVIDENCE_REVIEW_BACKUP_ARCHIVE_SCHEMA_VERSION,
    sealed_at: sealedAt,
    cipher: "AES-256-GCM",
    kdf: "PBKDF2-HMAC-SHA256",
    kdf_iterations: EVIDENCE_REVIEW_BACKUP_ARCHIVE_KDF_ITERATIONS,
    salt_base64url: bytesToBase64Url(salt),
    iv_base64url: bytesToBase64Url(iv),
    requires_human_restore: true,
    automatic_apply_allowed: false,
  };
}

async function deriveArchiveKey(passphrase, salt) {
  const subtle = cryptoApi().subtle;
  const material = await subtle.importKey(
    "raw",
    new TextEncoder().encode(assertPassphrase(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: EVIDENCE_REVIEW_BACKUP_ARCHIVE_KDF_ITERATIONS,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function randomBytes(length, source = null) {
  if (source !== null) {
    const value = source(length);
    if (!(value instanceof Uint8Array) || value.length !== length) {
      throw new Error("EVIDENCE_REVIEW_BACKUP_ARCHIVE_RANDOM_INVALID");
    }
    return value;
  }
  return cryptoApi().getRandomValues(new Uint8Array(length));
}

export async function sealEvidenceReviewAuditBackup({
  backup,
  passphrase,
  sealedAt,
  randomSource = null,
}) {
  await verifyEvidenceReviewAuditBackup(backup);
  assertPassphrase(passphrase);
  const salt = randomBytes(16, randomSource);
  const iv = randomBytes(12, randomSource);
  const metadata = archiveMetadata(sealedAt, salt, iv);
  const additionalData = new TextEncoder().encode(canonicalJson(metadata));
  const plaintext = new TextEncoder().encode(canonicalJson(backup));
  const key = await deriveArchiveKey(passphrase, salt);
  const encrypted = await cryptoApi().subtle.encrypt(
    { name: "AES-GCM", iv, additionalData, tagLength: 128 },
    key,
    plaintext,
  );
  const ciphertext = new Uint8Array(encrypted);
  const archive = {
    ...metadata,
    ciphertext_base64url: bytesToBase64Url(ciphertext),
    ciphertext_sha256: await sha256Hex(ciphertext),
  };
  if (!validateArchive(archive)) throw new Error("EVIDENCE_REVIEW_BACKUP_ARCHIVE_INVALID");
  return Object.freeze(archive);
}

export async function openEvidenceReviewAuditBackupArchive({ archive, passphrase }) {
  try {
    if (!validateArchive(archive)) throw new Error("EVIDENCE_REVIEW_BACKUP_ARCHIVE_INVALID");
    assertPassphrase(passphrase);
    const salt = base64UrlToBytes(archive.salt_base64url);
    const iv = base64UrlToBytes(archive.iv_base64url);
    if (salt.length !== 16 || iv.length !== 12) throw new Error("EVIDENCE_REVIEW_BACKUP_ARCHIVE_INVALID");
    const ciphertext = base64UrlToBytes(archive.ciphertext_base64url);
    if (archive.ciphertext_sha256 !== await sha256Hex(ciphertext)) {
      throw new Error("EVIDENCE_REVIEW_BACKUP_ARCHIVE_INVALID");
    }
    const { ciphertext_base64url: omittedCiphertext, ciphertext_sha256: omittedHash, ...metadata } = archive;
    const additionalData = new TextEncoder().encode(canonicalJson(metadata));
    const key = await deriveArchiveKey(passphrase, salt);
    const decrypted = await cryptoApi().subtle.decrypt(
      { name: "AES-GCM", iv, additionalData, tagLength: 128 },
      key,
      ciphertext,
    );
    const backup = JSON.parse(new TextDecoder().decode(decrypted));
    await verifyEvidenceReviewAuditBackup(backup);
    return Object.freeze(backup);
  } catch {
    throw new Error("EVIDENCE_REVIEW_BACKUP_ARCHIVE_INVALID");
  }
}
