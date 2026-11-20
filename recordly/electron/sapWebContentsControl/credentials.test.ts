import { describe, expect, it } from "vitest";
import { parseSapLoginCredentials } from "./credentials";

describe("parseSapLoginCredentials", () => {
	it("parses the four required in-memory login values", () => {
		const credentials = parseSapLoginCredentials(`
URL=https://sap.example.test/sap/bc/ui2/flp?sap-client=460
Client=460
User=fixture-user
Password=fixture-password
`);

		expect(credentials.url.origin).toBe("https://sap.example.test");
		expect(credentials.client).toBe("460");
		expect(credentials.user).toBe("fixture-user");
		expect(credentials.password).toBe("fixture-password");
	});

	it("accepts colon delimiters without splitting URL colons or query values", () => {
		const credentials = parseSapLoginCredentials(`
URL: https://sap.example.test:8443/sap/bc/ui2/flp?sap-client=460&mode=a:b
Client: 460
User: fixture-colon-user
Password: fixture-colon-password
`);

		expect(credentials.url.origin).toBe("https://sap.example.test:8443");
		expect(credentials.url.searchParams.get("mode")).toBe("a:b");
		expect(credentials.client).toBe("460");
	});

	it("rejects a mismatched client without including credential values in the error", () => {
		const source = `
URL=https://sap.example.test/sap/bc/ui2/flp?sap-client=460
Client=999
User=never-leak-this-user
Password=never-leak-this-password
`;
		let message = "";
		try {
			parseSapLoginCredentials(source);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("does not match");
		expect(message).not.toContain("never-leak-this-user");
		expect(message).not.toContain("never-leak-this-password");
	});
});
