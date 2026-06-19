import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import {
	getAccessToken,
	searchEmails,
	getEmailContent,
	getEmailDetails,
	getEmailHeaders,
	extractRfcMessageId,
	buildReplyHeaders,
	saveDraft,
	getFolders,
	listEmails,
	getAttachmentList,
	downloadAttachment,
	uploadAttachment,
	deleteEmail,
} from "./zoho";
import type { ZohoEnv } from "./zoho";

export interface Env extends ZohoEnv {
	ZOHO_MCP_API_KEY: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const apiKeyParam = url.searchParams.get("apiKey");
		const authHeader = request.headers.get("Authorization");

		const isAuthHeaderValid = authHeader === `Bearer ${env.ZOHO_MCP_API_KEY}`;
		const isQueryParamValid = apiKeyParam === env.ZOHO_MCP_API_KEY;

		if (!isAuthHeaderValid && !isQueryParamValid) {
			return new Response("Unauthorized", { status: 401 });
		}

		const server = new McpServer({
			name: "zoho-mail",
			version: "1.0.0",
		});

		async function withToken<T>(fn: (token: string, accountId: string) => Promise<T>): Promise<T> {
			const token = await getAccessToken(env);
			return fn(token, env.ZOHO_ACCOUNT_ID);
		}

		// ─── Tool 1: Search Emails ──────────────────────────────────────────────────
		server.registerTool(
			"search_emails",
			{
				description: "Search inbox and sent emails using Zoho Mail search syntax. Returns a list of matching email summaries. Use search keys like 'sender:email@example.com', 'subject:keyword', 'entire:keyword', or combine with '::' (e.g., 'sender:john@example.com::subject:Invoice').",
				inputSchema: {
					query: z.string().describe("Zoho search key (e.g., 'sender:john@example.com', 'subject:Invoice', 'entire:hello')"),
					limit: z.number().int().min(1).max(200).default(10).describe("Maximum number of results (1-200)"),
				},
				outputSchema: z.object({
					emails: z.array(z.object({
						messageId: z.string(),
						subject: z.string(),
						sender: z.string(),
						fromAddress: z.string(),
						toAddress: z.string(),
						ccAddress: z.string().optional(),
						folderId: z.string(),
						receivedTime: z.string(),
						summary: z.string(),
						hasAttachment: z.string()
					}))
				})
			},
			async ({ query, limit }) => {
				const results = await withToken((token, accountId) =>
					searchEmails(token, accountId, query, limit)
				);

				const structuredContent = {
					emails: results.map(e => ({
						messageId: e.messageId,
						subject: e.subject,
						sender: e.sender,
						fromAddress: e.fromAddress,
						toAddress: e.toAddress,
						ccAddress: e.ccAddress !== "Not Provided" ? e.ccAddress : undefined,
						folderId: e.folderId,
						receivedTime: e.receivedTime,
						summary: e.summary,
						hasAttachment: e.hasAttachment
					}))
				};

				if (results.length === 0) {
					return { content: [{ type: "text", text: "No emails found matching the query." }], structuredContent };
				}

				const formatted = results.map((e, i) =>
					[
						`--- Email ${i + 1} ---`,
						`Subject: ${e.subject}`,
						`From: ${e.sender} <${e.fromAddress}>`,
						`To: ${e.toAddress}`,
						e.ccAddress && e.ccAddress !== "Not Provided" ? `Cc: ${e.ccAddress}` : null,
						`Date: ${new Date(parseInt(e.receivedTime)).toISOString()}`,
						`Summary: ${e.summary}`,
						`Message ID: ${e.messageId}`,
						`Folder ID: ${e.folderId}`,
						`Has Attachment: ${e.hasAttachment !== "0" ? "Yes" : "No"}`,
					].filter(Boolean).join("\n")
				).join("\n\n");

				return { content: [{ type: "text", text: formatted }], structuredContent };
			}
		);

		// ─── Tool 2: Read Email ─────────────────────────────────────────────────────
		server.registerTool(
			"read_email",
			{
				description: "Read the full content and metadata of a specific email. Requires the messageId and folderId from search results.",
				inputSchema: {
					messageId: z.string().describe("Zoho message ID (from search results)"),
					folderId: z.string().describe("Zoho folder ID (from search results)"),
				},
				outputSchema: z.object({
					messageId: z.string(),
					folderId: z.string(),
					subject: z.string(),
					sender: z.string(),
					fromAddress: z.string(),
					toAddress: z.string(),
					ccAddress: z.string().optional(),
					sentDateInGMT: z.string(),
					content: z.string(),
					attachments: z.array(z.object({
						attachmentId: z.string(),
						attachmentName: z.string(),
						attachmentSize: z.string(),
						isInline: z.string()
					}))
				})
			},
			async ({ messageId, folderId }) => {
				const [details, content, attachments] = await withToken(async (token, accountId) =>
					Promise.all([
						getEmailDetails(token, accountId, folderId, messageId),
						getEmailContent(token, accountId, folderId, messageId),
						getAttachmentList(token, accountId, folderId, messageId).catch(() => []),
					])
				);

				const structuredContent = {
					messageId: details.messageId,
					folderId: details.folderId,
					subject: details.subject,
					sender: details.sender,
					fromAddress: details.fromAddress,
					toAddress: details.toAddress,
					ccAddress: details.ccAddress !== "Not Provided" ? details.ccAddress : undefined,
					sentDateInGMT: details.sentDateInGMT,
					content: content.content,
					attachments: attachments
				};

				const text = [
					`Subject: ${details.subject}`,
					`From: ${details.sender} <${details.fromAddress}>`,
					`To: ${details.toAddress}`,
					details.ccAddress && details.ccAddress !== "Not Provided" ? `Cc: ${details.ccAddress}` : null,
					`Date: ${new Date(parseInt(details.sentDateInGMT)).toISOString()}`,
					`Message ID: ${details.messageId}`,
					`Folder ID: ${details.folderId}`,
					attachments.length > 0 ? `\n--- Attachments ---\n${attachments.map(a => `- ${a.attachmentName} (ID: ${a.attachmentId}, Size: ${a.attachmentSize} bytes)`).join('\n')}` : null,
					"",
					"--- Content (HTML) ---",
					content.content,
				].filter((l) => l !== null).join("\n");

				return { content: [{ type: "text", text }], structuredContent };
			}
		);

		// ─── Tool 3: List Folders ────────────────────────────────────────────────────
		server.registerTool(
			"list_folders",
			{
				description: "List all email folders (Inbox, Sent, Drafts, etc.) with their folder IDs.",
				inputSchema: {},
				outputSchema: z.object({
					folders: z.array(z.object({
						folderId: z.string(),
						folderName: z.string()
					}))
				})
			},
			async () => {
				const folders = await withToken((token, accountId) =>
					getFolders(token, accountId)
				);

				const structuredContent = {
					folders: folders.map(f => ({
						folderId: f.folderId,
						folderName: f.folderName
					}))
				};

				const text = folders
					.map((f) => `${f.folderName}: ${f.folderId}`)
					.join("\n");

				return { content: [{ type: "text", text }], structuredContent };
			}
		);

		// ─── Tool 4: List Emails in Folder ──────────────────────────────────────────
		server.registerTool(
			"list_emails",
			{
				description: "List recent emails in a specific folder. Use list_folders first to get folder IDs.",
				inputSchema: {
					folderId: z.string().describe("Zoho folder ID"),
					limit: z.number().int().min(1).max(200).default(10).describe("Maximum number of results"),
				},
				outputSchema: z.object({
					emails: z.array(z.object({
						messageId: z.string(),
						subject: z.string(),
						sender: z.string(),
						fromAddress: z.string(),
						toAddress: z.string(),
						folderId: z.string(),
						receivedTime: z.string(),
						summary: z.string()
					}))
				})
			},
			async ({ folderId, limit }) => {
				const results = await withToken((token, accountId) =>
					listEmails(token, accountId, folderId, limit)
				);

				const structuredContent = {
					emails: results.map(e => ({
						messageId: e.messageId,
						subject: e.subject,
						sender: e.sender,
						fromAddress: e.fromAddress,
						toAddress: e.toAddress,
						folderId: e.folderId,
						receivedTime: e.receivedTime,
						summary: e.summary
					}))
				};

				if (results.length === 0) {
					return { content: [{ type: "text", text: "No emails found in this folder." }], structuredContent };
				}

				const formatted = results.map((e, i) =>
					[
						`--- Email ${i + 1} ---`,
						`Subject: ${e.subject}`,
						`From: ${e.sender} <${e.fromAddress}>`,
						`To: ${e.toAddress}`,
						`Date: ${new Date(parseInt(e.receivedTime)).toISOString()}`,
						`Summary: ${e.summary}`,
						`Message ID: ${e.messageId}`,
						`Folder ID: ${e.folderId}`,
					].join("\n")
				).join("\n\n");

				return { content: [{ type: "text", text: formatted }], structuredContent };
			}
		);

		// ─── Tool 5: Save Draft ─────────────────────────────────────────────────────
		server.registerTool(
			"save_draft",
			{
				description: "Save a new draft email to the Drafts folder. Use this for composing new emails or reply drafts.",
				inputSchema: {
					fromAddress: z.string().email().describe("Sender email address (e.g., 'pedro@knitlingo.com')"),
					toAddress: z.string().describe("Recipient email address(es), comma-separated"),
					subject: z.string().describe("Email subject line"),
					content: z.string().describe("Email body content (HTML supported)"),
					ccAddress: z.string().optional().describe("CC email address(es), comma-separated"),
					bccAddress: z.string().optional().describe("BCC email address(es), comma-separated"),
					inReplyTo: z.string().optional().describe("For replies: the `inReplyTo` value from get_email_headers (the RFC Message-ID of the email being replied to)."),
					refHeader: z.string().optional().describe("For replies: the `refHeader` value from get_email_headers — the full thread chain (all prior Message-IDs + the replied-to message, space-separated, chronological). Required for correct threading in multi-message threads; do NOT just repeat inReplyTo."),
					attachments: z.array(z.object({
						storeName: z.string(),
						attachmentName: z.string(),
						attachmentPath: z.string()
					})).optional().describe("Array of uploaded attachments from upload_attachment tool"),
				},
				outputSchema: z.object({
					messageId: z.string(),
					mailId: z.string(),
					subject: z.string(),
					fromAddress: z.string(),
					toAddress: z.string(),
					ccAddress: z.string().optional()
				})
			},
			async (params) => {
				const result = await withToken((token, accountId) =>
					saveDraft(token, accountId, params)
				);

				const structuredContent = {
					messageId: result.messageId,
					mailId: result.mailId,
					subject: result.subject,
					fromAddress: result.fromAddress,
					toAddress: result.toAddress,
					ccAddress: result.ccAddress
				};

				const text = [
					"✅ Draft saved successfully!",
					"",
					`Subject: ${result.subject}`,
					`From: ${result.fromAddress}`,
					`To: ${result.toAddress}`,
					result.ccAddress ? `Cc: ${result.ccAddress}` : null,
					`Draft Message ID: ${result.messageId}`,
					`Mail ID: ${result.mailId}`,
				].filter(Boolean).join("\n");

				return { content: [{ type: "text", text }], structuredContent };
			}
		);

		// ─── Tool 6: Get Email Headers ──────────────────────────────────────────────
		server.registerTool(
			"get_email_headers",
			{
				description: "Get the raw RFC headers of an email plus ready-to-use reply threading values. To reply within a thread exactly like the web UI, pass the returned `inReplyTo` and `refHeader` straight into save_draft (or edit_draft). `refHeader` is the full thread chain, so threading stays correct even in long multi-message threads.",
				inputSchema: {
					messageId: z.string().describe("Zoho message ID"),
					folderId: z.string().describe("Zoho folder ID"),
				},
				outputSchema: z.object({
					rfcMessageId: z.string().nullable(),
					inReplyTo: z.string().nullable(),
					refHeader: z.string().nullable(),
					rawHeaders: z.string()
				})
			},
			async ({ messageId, folderId }) => {
				const headers = await withToken((token, accountId) =>
					getEmailHeaders(token, accountId, folderId, messageId)
				);

				const rfcId = extractRfcMessageId(headers);
				const { inReplyTo, refHeader } = buildReplyHeaders(headers);

				const structuredContent = {
					rfcMessageId: rfcId,
					inReplyTo,
					refHeader,
					rawHeaders: headers
				};

				const text = [
					rfcId ? `RFC Message-ID: ${rfcId}` : "Could not extract Message-ID from headers.",
					`Reply inReplyTo: ${inReplyTo ?? "(none)"}`,
					`Reply refHeader: ${refHeader ?? "(none)"}`,
					"",
					"--- Full Headers ---",
					headers,
				].join("\n");

				return { content: [{ type: "text", text }], structuredContent };
			}
		);

		// ─── Tool 7: Download Attachment ────────────────────────────────────────────
		server.registerTool(
			"download_attachment",
			{
				description: "Download a specific email attachment by its ID. Returns the base64-encoded file data.",
				inputSchema: {
					messageId: z.string().describe("Zoho message ID"),
					folderId: z.string().describe("Zoho folder ID"),
					attachmentId: z.string().describe("Zoho attachment ID"),
				},
				outputSchema: z.object({
					base64Data: z.string()
				})
			},
			async ({ messageId, folderId, attachmentId }) => {
				const base64Data = await withToken((token, accountId) =>
					downloadAttachment(token, accountId, folderId, messageId, attachmentId)
				);
				return {
					content: [{ type: "text", text: `Base64 encoded attachment data (${base64Data.length} chars).` }],
					structuredContent: { base64Data }
				};
			}
		);

		// ─── Tool 8: Upload Attachment ──────────────────────────────────────────────
		server.registerTool(
			"upload_attachment",
			{
				description: "Upload an attachment for a new draft. You must provide the file name and base64-encoded file content. Returns the storeName and attachmentPath needed for save_draft.",
				inputSchema: {
					fileName: z.string().describe("File name with extension (e.g., 'invoice.pdf')"),
					base64Data: z.string().describe("Base64-encoded file content"),
				},
				outputSchema: z.object({
					storeName: z.string(),
					attachmentName: z.string(),
					attachmentPath: z.string()
				})
			},
			async ({ fileName, base64Data }) => {
				const result = await withToken((token, accountId) =>
					uploadAttachment(token, accountId, fileName, base64Data)
				);
				return {
					content: [{ type: "text", text: `Attachment uploaded successfully. Store name: ${result.storeName}` }],
					structuredContent: result
				};
			}
		);

		// ─── Tool 9: Delete Draft ───────────────────────────────────────────────────
		server.registerTool(
			"delete_draft",
			{
				description: "Delete a draft (moves it to Trash).",
				inputSchema: {
					messageId: z.string().describe("Zoho message ID of the draft to delete"),
					folderId: z.string().describe("Zoho folder ID of the draft — must be the Drafts folder, otherwise the request is rejected"),
				},
				outputSchema: z.object({
					deleted: z.boolean(),
					messageId: z.string()
				})
			},
			async ({ messageId, folderId }) => {
				await withToken(async (token, accountId) => {
					// Safety guard: only ever delete from the Drafts folder. This tool must never
					// be able to delete real Inbox/Sent emails, even if given another folderId.
					const folders = await getFolders(token, accountId);
					const drafts = folders.find((f) => f.folderName.toLowerCase() === "drafts");
					if (!drafts) {
						throw new Error("Could not resolve the Drafts folder; refusing to delete.");
					}
					if (folderId !== drafts.folderId) {
						throw new Error(
							`Refusing to delete: folderId ${folderId} is not the Drafts folder (${drafts.folderId}). delete_draft only deletes drafts.`
						);
					}
					await deleteEmail(token, accountId, folderId, messageId);
				});
				return {
					content: [{ type: "text", text: `🗑️ Draft ${messageId} deleted (moved to Trash).` }],
					structuredContent: { deleted: true, messageId }
				};
			}
		);

		// ─── Tool 10: Edit Draft ────────────────────────────────────────────────────
		server.registerTool(
			"edit_draft",
			{
				description: "Edit an existing draft, replacing its content. Pass the full desired content; this is a replace, not a patch. Returns the updated draft's messageId (it may differ from the original). For reply drafts, re-supply inReplyTo/refHeader to preserve threading.",
				inputSchema: {
					oldMessageId: z.string().describe("messageId of the existing draft to replace"),
					oldFolderId: z.string().describe("folderId of the existing draft (usually the Drafts folder)"),
					fromAddress: z.string().email().describe("Sender email address"),
					toAddress: z.string().describe("Recipient email address(es), comma-separated"),
					subject: z.string().describe("Email subject line"),
					content: z.string().describe("Full email body content (HTML supported). Replaces the old content entirely."),
					ccAddress: z.string().optional().describe("CC email address(es), comma-separated"),
					bccAddress: z.string().optional().describe("BCC email address(es), comma-separated"),
					inReplyTo: z.string().optional().describe("For reply drafts: the `inReplyTo` from get_email_headers."),
					refHeader: z.string().optional().describe("For reply drafts: the `refHeader` from get_email_headers (full thread chain)."),
					attachments: z.array(z.object({
						storeName: z.string(),
						attachmentName: z.string(),
						attachmentPath: z.string()
					})).optional().describe("Array of uploaded attachments from upload_attachment tool"),
				},
				outputSchema: z.object({
					messageId: z.string(),
					mailId: z.string(),
					subject: z.string(),
					fromAddress: z.string(),
					toAddress: z.string(),
					ccAddress: z.string().optional(),
					oldDraftDeleted: z.boolean()
				})
			},
			async ({ oldMessageId, oldFolderId, ...draft }) => {
				const { result, oldDraftDeleted } = await withToken(async (token, accountId) => {
					// Save the new draft FIRST so content is never lost if the delete fails.
					const result = await saveDraft(token, accountId, draft);
					let oldDraftDeleted = false;
					try {
						// Safety guard: only remove the old message if it's actually in Drafts,
						// so edit_draft can never delete a real Inbox/Sent email.
						const folders = await getFolders(token, accountId);
						const drafts = folders.find((f) => f.folderName.toLowerCase() === "drafts");
						if (drafts && oldFolderId === drafts.folderId) {
							await deleteEmail(token, accountId, oldFolderId, oldMessageId);
							oldDraftDeleted = true;
						}
					} catch {
						oldDraftDeleted = false;
					}
					return { result, oldDraftDeleted };
				});

				const text = [
					"✏️ Draft updated (saved new, removed old).",
					`Subject: ${result.subject}`,
					`From: ${result.fromAddress}`,
					`To: ${result.toAddress}`,
					result.ccAddress ? `Cc: ${result.ccAddress}` : null,
					`New Draft Message ID: ${result.messageId}`,
					oldDraftDeleted
						? `Old draft ${oldMessageId} deleted.`
						: `⚠️ Could not delete old draft ${oldMessageId} — delete it manually to avoid a duplicate.`,
				].filter(Boolean).join("\n");

				return {
					content: [{ type: "text", text }],
					structuredContent: {
						messageId: result.messageId,
						mailId: result.mailId,
						subject: result.subject,
						fromAddress: result.fromAddress,
						toAddress: result.toAddress,
						ccAddress: result.ccAddress,
						oldDraftDeleted
					}
				};
			}
		);

		const handler = createMcpHandler(server);
		return handler(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
