import { describe, expect, it } from "vitest";

import {
	CERTIFICATE_VERIFY_OK,
	COMMON_NAME_INVALID_RESULT,
	ERR_CERT_COMMON_NAME_INVALID,
	getSapQasCertificateVerificationResult,
	SAP_QAS_CERTIFICATE_PIN,
	USE_CHROMIUM_CERTIFICATE_VERIFICATION,
} from "./certificatePolicy";

const exactMatch = {
	hostname: SAP_QAS_CERTIFICATE_PIN.hostname,
	errorCode: ERR_CERT_COMMON_NAME_INVALID,
	verificationResult: COMMON_NAME_INVALID_RESULT,
	fingerprint: SAP_QAS_CERTIFICATE_PIN.electronFingerprint,
};

describe("getSapQasCertificateVerificationResult", () => {
	it("allows only the pinned SAP QAS certificate for its missing-SAN hostname error", () => {
		expect(getSapQasCertificateVerificationResult(exactMatch)).toBe(CERTIFICATE_VERIFY_OK);
	});

	it.each([
		{ ...exactMatch, hostname: `other.${SAP_QAS_CERTIFICATE_PIN.hostname}` },
		{ ...exactMatch, hostname: SAP_QAS_CERTIFICATE_PIN.hostname.toUpperCase() },
		{ ...exactMatch, fingerprint: "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
		{ ...exactMatch, fingerprint: SAP_QAS_CERTIFICATE_PIN.sha256 },
		{ ...exactMatch, errorCode: -202 },
		{ ...exactMatch, errorCode: 0 },
		{ ...exactMatch, verificationResult: "net::ERR_CERT_AUTHORITY_INVALID" },
	])("uses Chromium verification for every non-exact request: %#", (request) => {
		expect(getSapQasCertificateVerificationResult(request)).toBe(
			USE_CHROMIUM_CERTIFICATE_VERIFICATION,
		);
	});
});
