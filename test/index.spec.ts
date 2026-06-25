import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

describe("Zoho Mail MCP Server Auth", () => {
	it("responds with 401 Unauthorized when no credentials are provided", async () => {
		const request = new Request("http://example.com/message");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
		expect(await response.text()).toBe("Unauthorized");
	});

	it("bypasses auth when valid ZOHO_MCP_API_KEY is provided in query param", async () => {
		const request = new Request(
			`http://example.com/message?apiKey=${env.ZOHO_MCP_API_KEY}`
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		// It shouldn't be 401
		expect(response.status).not.toBe(401);
	});

	it("bypasses auth when valid ZOHO_MCP_API_KEY is provided in Authorization header", async () => {
		const request = new Request("http://example.com/message", {
			headers: {
				Authorization: `Bearer ${env.ZOHO_MCP_API_KEY}`,
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).not.toBe(401);
	});
});
