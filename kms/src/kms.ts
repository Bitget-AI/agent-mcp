// KMS-backed npm token decryption.
//
// Company-standard encrypted token format:
//
//   kms#<KMS-key-ARN>#<base64-encryptedAesKey>#<hex-MD5-of-decryptedAesKey>#<base64-AES-GCM-encryptedToken>
//
// Decryption steps (matching @Sec Ma's encryption tool conventions):
//   1. Parse the five `#`-delimited fields.
//   2. Use AWS Encryption SDK with a strict KMS keyring to decrypt
//      `encryptedAesKey` and recover the shared AES-256 key.
//   3. Verify MD5(decryptedAesKey as UTF-8 text) matches the embedded MD5.
//   4. AES-256-GCM decrypt `encryptedTokenBlob` with that key. Layout matches
//      the main repo: IV(16) || ciphertext || tag(16).
//   5. Return the UTF-8 plaintext npm token.

import {
  CommitmentPolicy,
  buildAwsKmsMrkAwareStrictMultiKeyringNode,
  buildClient,
} from "@aws-crypto/client-node";
import { createDecipheriv, createHash } from "node:crypto";

const TOKEN_FORMAT = /^kms#([^#]+)#([^#]+)#([^#]+)#(.+)$/;
const AES_KEY_LEN = 32;
const GCM_IV_LEN = 16;
const GCM_TAG_LEN = 16;
const { decrypt } = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT);

interface ParsedToken {
  kmsKeyArn: string;
  encryptedAesKey: Buffer;
  expectedKeyMd5: string;
  encryptedTokenBlob: Buffer;
}

function kmsArnSummary(arn: string): string {
  const parts = arn.split(":");
  const region = parts[3] || "unknown-region";
  const account = parts[4] || "unknown-account";
  const resource = parts.slice(5).join(":") || "unknown-resource";
  return `region=${region}, account=${account}, resource=${resource}`;
}

function parse(encrypted: string): ParsedToken {
  const m = TOKEN_FORMAT.exec(encrypted);
  if (!m) {
    throw new Error(
      "Encrypted token does not match expected format " +
        "kms#<arn>#<encKey>#<md5>#<encData>",
    );
  }
  return {
    kmsKeyArn: m[1],
    encryptedAesKey: Buffer.from(m[2], "base64"),
    expectedKeyMd5: m[3].toLowerCase(),
    encryptedTokenBlob: Buffer.from(m[4], "base64"),
  };
}

async function kmsDecryptAesKey(
  arn: string,
  encryptedDataKey: Buffer,
): Promise<Buffer> {
  const parts = arn.split(":");
  if (parts.length < 6 || parts[0] !== "arn" || parts[2] !== "kms") {
    throw new Error(`Invalid KMS ARN: ${arn}`);
  }
  const keyring = buildAwsKmsMrkAwareStrictMultiKeyringNode({ keyIds: [arn] });
  console.error(
    "KMS decrypt data key context: " +
      `${kmsArnSummary(arn)}, ` +
      `keyring=${keyring.constructor.name}, ` +
      `encryptedDataKeyBytes=${encryptedDataKey.length}`,
  );

  let plaintext: Buffer;
  try {
    const result = await decrypt(keyring, encryptedDataKey);
    plaintext = Buffer.from(result.plaintext);
    console.error(
      "KMS decrypt data key succeeded: " +
        `plaintextBytes=${plaintext.length}, ` +
        `messageId=${result.messageHeader.messageId}`,
    );
  } catch (err: unknown) {
    throw new Error(
      "AWS Encryption SDK failed to decrypt encrypted data key " +
        `(${kmsArnSummary(arn)}, encryptedDataKeyBytes=${encryptedDataKey.length})`,
      { cause: err },
    );
  }

  if (!plaintext.length) {
    throw new Error("AWS Encryption SDK returned no plaintext for the AES key");
  }
  return plaintext;
}

function verifyKeyMd5(aesKey: Buffer, expectedHex: string): void {
  const actual = createHash("md5")
    .update(aesKey.toString("utf8"), "utf8")
    .digest("hex")
    .toLowerCase();
  if (actual !== expectedHex) {
    throw new Error(
      `Decrypted AES key MD5 mismatch: expected ${expectedHex}, got ${actual}`,
    );
  }
}

function aesGcmDecrypt(blob: Buffer, key: Buffer): string {
  console.error(
    "AES-GCM payload context: " +
      `blobBytes=${blob.length}, keyBytes=${key.length}, ` +
      `ivBytes=${GCM_IV_LEN}, tagBytes=${GCM_TAG_LEN}`,
  );
  if (blob.length <= GCM_IV_LEN + GCM_TAG_LEN) {
    throw new Error(
      `AES-GCM blob too short: ${blob.length} bytes, ` +
        `need more than ${GCM_IV_LEN + GCM_TAG_LEN}`,
    );
  }
  const iv = blob.subarray(0, GCM_IV_LEN);
  const tag = blob.subarray(blob.length - GCM_TAG_LEN);
  const ciphertext = blob.subarray(GCM_IV_LEN, blob.length - GCM_TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    console.error("AES-GCM decrypt succeeded.");
    return plaintext;
  } catch (err: unknown) {
    throw new Error(
      "AES-GCM failed to decrypt encrypted token payload " +
        `(blobBytes=${blob.length}, keyBytes=${key.length}, ` +
        `ivBytes=${GCM_IV_LEN}, tagBytes=${GCM_TAG_LEN})`,
      { cause: err },
    );
  }
}

export async function decryptToken(encrypted: string): Promise<string> {
  const parsed = parse(encrypted);
  console.error(
    "Parsed KMS token context: " +
      `${kmsArnSummary(parsed.kmsKeyArn)}, ` +
      `encryptedDataKeyBytes=${parsed.encryptedAesKey.length}, ` +
      `expectedMd5Length=${parsed.expectedKeyMd5.length}, ` +
      `encryptedPayloadBytes=${parsed.encryptedTokenBlob.length}`,
  );
  const aesKey = await kmsDecryptAesKey(parsed.kmsKeyArn, parsed.encryptedAesKey);
  if (aesKey.length !== AES_KEY_LEN) {
    throw new Error(
      `Expected ${AES_KEY_LEN}-byte AES-256 key from KMS, got ${aesKey.length}`,
    );
  }
  verifyKeyMd5(aesKey, parsed.expectedKeyMd5);
  console.error("KMS data key MD5 verification succeeded.");
  return aesGcmDecrypt(parsed.encryptedTokenBlob, aesKey);
}
