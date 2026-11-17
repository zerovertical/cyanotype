// Creates the one signing key every Cyanotype release is signed with.
//
//   npm run signing-key
//
// Android only installs an update over an existing app if both are signed with
// the same key, so this is made ONCE and kept forever. Lose it and every phone
// has to uninstall (losing its chats) before it can take another update.
//
// Writes two files into ./signing/ (which git ignores):
//   cyanotype-release.p12   the key itself: back it up somewhere safe
//   github-secrets.txt      the four values to paste into GitHub, then delete
//
// Nothing here needs Java or Android Studio: Node makes the key, node-forge
// packs it into a PKCS#12 keystore, which Android's build tools read directly.

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import forge from "node-forge";

const DIR = "signing";
const KEYSTORE = join(DIR, "cyanotype-release.p12");
const SECRETS = join(DIR, "github-secrets.txt");
const ALIAS = "cyanotype";

if (existsSync(KEYSTORE)) {
  console.error(`\n${KEYSTORE} already exists. Refusing to overwrite it.\n` +
    "If it is the key your releases are signed with, replacing it would stop\n" +
    "every installed copy from updating. Move it somewhere safe first if you\n" +
    "really mean to start again.\n");
  process.exit(1);
}

console.log("Generating a 4096-bit RSA key. This takes a few seconds...");
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 4096,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const key = forge.pki.privateKeyFromPem(privateKey);
const cert = forge.pki.createCertificate();
cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
// A positive serial: the top bit of the first byte must be clear.
const serial = randomBytes(16);
serial[0] &= 0x7f;
cert.serialNumber = serial.toString("hex");
cert.validity.notBefore = new Date(Date.now() - 864e5);
cert.validity.notAfter = new Date();
// Android wants signing certificates to outlive the app. 50 years is plenty.
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 50);
const subject = [{ name: "commonName", value: "Cyanotype" }, { name: "organizationName", value: "Cyanotype" }];
cert.setSubject(subject);
cert.setIssuer(subject);
cert.setExtensions([{ name: "basicConstraints", cA: false }]);
cert.sign(key, forge.md.sha256.create());

// Letters and digits only, so it survives being pasted anywhere.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const password = Array.from(randomBytes(32), (b) => ALPHABET[b % ALPHABET.length]).join("");

// PKCS#12 keystores use one password for the store and the key.
const p12 = forge.pkcs12.toPkcs12Asn1(key, [cert], password, {
  algorithm: "aes256",
  friendlyName: ALIAS,
  generateLocalKeyId: true,
});
const der = Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary");

mkdirSync(DIR, { recursive: true });
writeFileSync(KEYSTORE, der);
writeFileSync(SECRETS, [
  "Paste each of these into GitHub: your repo > Settings > Secrets and variables",
  "> Actions > New repository secret. The name goes in 'Name', the value in 'Secret'.",
  "Delete this file once they are saved. Keep cyanotype-release.p12 backed up.",
  "",
  "Name:  ANDROID_KEYSTORE_PASSWORD",
  "Value: " + password,
  "",
  "Name:  ANDROID_KEY_ALIAS",
  "Value: " + ALIAS,
  "",
  "Name:  ANDROID_KEY_PASSWORD",
  "Value: " + password,
  "",
  "Name:  ANDROID_KEYSTORE_BASE64",
  "Value (one long line, copy all of it):",
  der.toString("base64"),
  "",
].join("\n"));

console.log(`
Done.

  ${KEYSTORE}
      The signing key. Back it up somewhere safe that is NOT GitHub
      (a password manager or a USB stick). Never commit it.

  ${SECRETS}
      Four values to paste into GitHub as secrets. Delete it afterwards.

Certificate fingerprint (SHA-256), for your records:
  ${forge.md.sha256.create().update(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()).digest().toHex().toUpperCase().match(/../g).join(":")}
`);
