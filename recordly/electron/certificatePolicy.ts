import type { Session } from "electron";

// Placeholder pin. Replace the hostname below and this SHA-256 with your own SAP QAS
// server certificate before use; the all-zero value never matches a real certificate.
const SAP_QAS_SHA256 = "0000000000000000000000000000000000000000000000000000000000000000";

function toElectronSha256Fingerprint(sha256: string): string {
	if (!/^[0-9a-f]{64}$/.test(sha256)) {
		throw new Error("Pinned certificate SHA-256 must be 64 lowercase hexadecimal characters.");
	}

	return `sha256/${Buffer.from(sha256, "hex").toString("base64")}`;
}

export const SAP_QAS_CERTIFICATE_PIN = {
	hostname: "sap-qas.example.invalid",
	sha256: SAP_QAS_SHA256,
	electronFingerprint: toElectronSha256Fingerprint(SAP_QAS_SHA256),
} as const;

export const CERTIFICATE_VERIFY_OK = 0;
export const USE_CHROMIUM_CERTIFICATE_VERIFICATION = -3;
export const ERR_CERT_COMMON_NAME_INVALID = -200;
export const COMMON_NAME_INVALID_RESULT = "net::ERR_CERT_COMMON_NAME_INVALID";

interface CertificatePinDecisionInput {
	hostname: string;
	errorCode: number;
	verificationResult: string;
	fingerprint: string;
}

export function getSapQasCertificateVerificationResult({
	hostname,
	errorCode,
	verificationResult,
	fingerprint,
}: CertificatePinDecisionInput): number {
	if (
		hostname === SAP_QAS_CERTIFICATE_PIN.hostname &&
		errorCode === ERR_CERT_COMMON_NAME_INVALID &&
		verificationResult === COMMON_NAME_INVALID_RESULT &&
		fingerprint === SAP_QAS_CERTIFICATE_PIN.electronFingerprint
	) {
		return CERTIFICATE_VERIFY_OK;
	}

	return USE_CHROMIUM_CERTIFICATE_VERIFICATION;
}

export function installSapQasCertificatePinning(targetSession: Session): void {
	targetSession.setCertificateVerifyProc((request, callback) => {
		callback(
			getSapQasCertificateVerificationResult({
				hostname: request.hostname,
				errorCode: request.errorCode,
				verificationResult: request.verificationResult,
				fingerprint: request.certificate.fingerprint,
			}),
		);
	});
}
