import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

/**
 * A software authenticator, so the passkey ceremonies can be tested for real.
 *
 * Passkey verification is the one part of sign-in with no way to check it by
 * inspection: either the server accepts a signature it should and refuses one
 * it should not, or it does not, and only running both proves which. So this
 * builds the same bytes a phone would, and the tests drive the real routes
 * with them.
 *
 * It is a fixture, not a library. It supports exactly ES256 with no
 * attestation, which is what Vigilo asks browsers for.
 */

/* ------------------------------------------------------------------- CBOR */

function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) {
    const out = Buffer.alloc(3);
    out[0] = (major << 5) | 25;
    out.writeUInt16BE(value, 1);
    return out;
  }
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(value, 1);
  return out;
}

function int(value: number): Buffer {
  return value >= 0 ? head(0, value) : head(1, -value - 1);
}

function bytes(value: Buffer): Buffer {
  return Buffer.concat([head(2, value.length), value]);
}

function text(value: string): Buffer {
  const encoded = Buffer.from(value, 'utf8');
  return Buffer.concat([head(3, encoded.length), encoded]);
}

function map(entries: [Buffer, Buffer][]): Buffer {
  return Buffer.concat([head(5, entries.length), ...entries.flat()]);
}

/* ---------------------------------------------------------------- the bits */

const AAGUID = Buffer.alloc(16);

/** User present, user verified, backup eligible, backed up, attested data. */
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export type AuthenticatorOptions = {
  /** A synced passkey sets backup eligible and backed up, as a phone does. */
  synced?: boolean;
  /** Answer without verifying the person, which the server has to refuse. */
  verifies?: boolean;
};

export class TestAuthenticator {
  readonly credentialId = randomBytes(32);

  readonly #keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  readonly #synced: boolean;
  readonly #verifies: boolean;
  #signCount = 0;

  constructor(options: AuthenticatorOptions = {}) {
    this.#synced = options.synced ?? true;
    this.#verifies = options.verifies ?? true;
  }

  get id(): string {
    return this.credentialId.toString('base64url');
  }

  /** The registration response, as `navigator.credentials.create` returns it. */
  register(input: { challenge: string; rpId: string; origin: string }): Record<string, unknown> {
    const clientDataJSON = this.#clientData('webauthn.create', input.challenge, input.origin);
    const authData = Buffer.concat([this.#authData(input.rpId, true)]);

    const attestationObject = map([
      [text('fmt'), text('none')],
      [text('attStmt'), map([])],
      [text('authData'), bytes(authData)],
    ]);

    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        attestationObject: attestationObject.toString('base64url'),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** The assertion, as `navigator.credentials.get` returns it. */
  authenticate(input: {
    challenge: string;
    rpId: string;
    origin: string;
  }): Record<string, unknown> {
    this.#signCount += 1;
    const clientDataJSON = this.#clientData('webauthn.get', input.challenge, input.origin);
    const authData = this.#authData(input.rpId, false);

    const signature = createSign('sha256')
      .update(Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]))
      .sign(this.#keys.privateKey);

    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'),
        userHandle: null,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  #clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
  }

  #authData(rpId: string, attested: boolean): Buffer {
    let flags = FLAG_UP;
    if (this.#verifies) flags |= FLAG_UV;
    if (this.#synced) flags |= FLAG_BE | FLAG_BS;
    if (attested) flags |= FLAG_AT;

    const header = Buffer.concat([
      createHash('sha256').update(rpId, 'utf8').digest(),
      Buffer.from([flags]),
      countBytes(this.#signCount),
    ]);

    if (!attested) return header;

    const length = Buffer.alloc(2);
    length.writeUInt16BE(this.credentialId.length);

    return Buffer.concat([header, AAGUID, length, this.credentialId, this.#coseKey()]);
  }

  /** ES256 over P-256, which is the first algorithm Vigilo asks for. */
  #coseKey(): Buffer {
    const jwk = this.#keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string };

    return map([
      [int(1), int(2)], // kty: EC2
      [int(3), int(-7)], // alg: ES256
      [int(-1), int(1)], // crv: P-256
      [int(-2), bytes(Buffer.from(jwk.x, 'base64url'))],
      [int(-3), bytes(Buffer.from(jwk.y, 'base64url'))],
    ]);
  }
}

function countBytes(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}
