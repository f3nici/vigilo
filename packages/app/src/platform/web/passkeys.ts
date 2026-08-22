import {
  passkeyTransports,
  type PasskeyAuthentication,
  type PasskeyRegistration,
  type PasskeyTransport,
} from '@vigilo/shared';
import { PasskeyError, type PasskeyAvailability, type Passkeys } from '../types.js';

/**
 * The WebAuthn ceremonies, on the PWA (#24).
 *
 * Everything WebAuthn lives behind the platform boundary, which is why this is
 * a third adapter rather than three calls in a view. The native builds do the
 * same two ceremonies through Capacitor and everything above here is unchanged.
 *
 * Options arrive from the server as JSON, because that is what crosses a wire,
 * and the browser wants `ArrayBuffer`s. The conversion is here rather than on
 * the server so the contract stays plain JSON in both directions.
 *
 * A cancelled prompt is not an error. Somebody who thinks better of it and
 * presses escape has not hit a fault, so the adapter returns null and the
 * screen carries on with the password field it was already showing.
 *
 * Everything else is. Both ceremonies used to `catch(() => null)`, which made
 * a cancellation and a browser that cannot run WebAuthn at all indistinguishable
 * to the caller, and the caller stays quiet for a cancellation on purpose. The
 * result was a button that did nothing and said nothing. `ceremonyFailed`
 * keeps the one case that means "changed my mind" and turns the rest into a
 * `PasskeyError` with something a person can act on.
 */

function toBase64Url(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out.buffer;
}

type JsonOptions = Record<string, unknown>;

function creationOptions(json: JsonOptions): PublicKeyCredentialCreationOptions {
  const user = json.user as { id: string; name: string; displayName: string };
  const exclude = (json.excludeCredentials ?? []) as { id: string; transports?: string[] }[];

  return {
    ...(json as unknown as PublicKeyCredentialCreationOptions),
    challenge: fromBase64Url(json.challenge as string),
    user: { ...user, id: fromBase64Url(user.id) },
    excludeCredentials: exclude.map((one) => ({
      type: 'public-key' as const,
      id: fromBase64Url(one.id),
      ...(one.transports === undefined
        ? {}
        : { transports: one.transports as AuthenticatorTransport[] }),
    })),
  };
}

function requestOptions(json: JsonOptions): PublicKeyCredentialRequestOptions {
  const allow = (json.allowCredentials ?? []) as { id: string; transports?: string[] }[];

  return {
    ...(json as unknown as PublicKeyCredentialRequestOptions),
    challenge: fromBase64Url(json.challenge as string),
    allowCredentials: allow.map((one) => ({
      type: 'public-key' as const,
      id: fromBase64Url(one.id),
      ...(one.transports === undefined
        ? {}
        : { transports: one.transports as AuthenticatorTransport[] }),
    })),
  };
}

/**
 * Cancellation, or a fault worth saying out loud.
 *
 * `NotAllowedError` is the one WebAuthn raises both when somebody dismisses the
 * prompt and when the ceremony times out. The two are the same thing to a
 * person watching: nothing happened and they know why, so it returns null.
 *
 * `InvalidStateError` gets its own line because it is the common one and the
 * generic wording is actively misleading: the ceremony was refused precisely
 * because this authenticator already holds a passkey for this account, which
 * is a success from yesterday rather than a failure today.
 */
function ceremonyFailed(ceremony: 'create' | 'get', error: unknown): null {
  const name = error instanceof DOMException ? error.name : '';

  if (name === 'NotAllowedError' || name === 'AbortError') return null;

  // The detail is for whoever opens the console, never for the screen.
  console.error(`passkey ${ceremony} failed`, error);

  switch (name) {
    case 'InvalidStateError':
      throw new PasskeyError('This device already has a passkey for your account.', error);
    case 'NotSupportedError':
      throw new PasskeyError('This device cannot make a passkey Vigilo can use.', error);
    case 'SecurityError':
      throw new PasskeyError(
        'Passkeys need Vigilo served over HTTPS on its own address. Tell whoever set up this server.',
        error,
      );
    case 'ConstraintError':
      throw new PasskeyError(
        'This device needs a screen lock, fingerprint or face set up before it can hold a passkey.',
        error,
      );
    default:
      throw new PasskeyError(
        ceremony === 'create'
          ? 'The passkey could not be set up on this device.'
          : 'That passkey could not be used to sign you in.',
        error,
      );
  }
}

export class WebPasskeys implements Passkeys {
  async availability(): Promise<PasskeyAvailability> {
    if (typeof window === 'undefined' || typeof window.PublicKeyCredential === 'undefined') {
      return { supported: false, platformAuthenticator: false };
    }

    try {
      return {
        supported: true,
        platformAuthenticator:
          await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),
      };
    } catch {
      // Supported enough to have the object and not enough to answer. A
      // security key still works, so this is not "no passkeys here".
      return { supported: true, platformAuthenticator: false };
    }
  }

  async create(options: JsonOptions): Promise<PasskeyRegistration | null> {
    let credential: PublicKeyCredential | null;
    try {
      credential = (await navigator.credentials.create({
        publicKey: creationOptions(options),
      })) as PublicKeyCredential | null;
    } catch (error) {
      return ceremonyFailed('create', error);
    }

    if (!credential) return null;

    const response = credential.response as AuthenticatorAttestationResponse;
    // Browsers report transports this contract has never heard of. They are a
    // hint about where the credential lives and nothing depends on them, so an
    // unknown one is dropped rather than being allowed to fail the whole
    // registration on the way through the schema.
    const transports = (response.getTransports?.() ?? []).filter((one): one is PasskeyTransport =>
      (passkeyTransports as readonly string[]).includes(one),
    );

    return {
      id: credential.id,
      rawId: toBase64Url(credential.rawId),
      type: 'public-key',
      response: {
        clientDataJSON: toBase64Url(response.clientDataJSON),
        attestationObject: toBase64Url(response.attestationObject),
        transports,
      },
      clientExtensionResults: {},
      authenticatorAttachment: attachmentOf(credential),
    };
  }

  async get(options: JsonOptions): Promise<PasskeyAuthentication | null> {
    let assertion: PublicKeyCredential | null;
    try {
      assertion = (await navigator.credentials.get({
        publicKey: requestOptions(options),
      })) as PublicKeyCredential | null;
    } catch (error) {
      return ceremonyFailed('get', error);
    }

    if (!assertion) return null;

    const response = assertion.response as AuthenticatorAssertionResponse;

    return {
      id: assertion.id,
      rawId: toBase64Url(assertion.rawId),
      type: 'public-key',
      response: {
        clientDataJSON: toBase64Url(response.clientDataJSON),
        authenticatorData: toBase64Url(response.authenticatorData),
        signature: toBase64Url(response.signature),
        userHandle: response.userHandle ? toBase64Url(response.userHandle) : null,
      },
      clientExtensionResults: {},
      authenticatorAttachment: attachmentOf(assertion),
    };
  }
}

function attachmentOf(credential: PublicKeyCredential): 'platform' | 'cross-platform' | null {
  const value = credential.authenticatorAttachment;
  return value === 'platform' || value === 'cross-platform' ? value : null;
}
