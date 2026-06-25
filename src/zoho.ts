/**
 * Zoho Mail API client for Cloudflare Workers.
 * Handles OAuth token refresh, email search, reading, drafts, and attachments.
 */

const ZOHO_ACCOUNTS_URL = "https://accounts.zoho.com/oauth/v2/token";
const ZOHO_MAIL_BASE = "https://mail.zoho.com/api";

export interface ZohoEnv {
	ZOHO_CLIENT_ID: string;
	ZOHO_CLIENT_SECRET: string;
	ZOHO_REFRESH_TOKEN: string;
	ZOHO_ACCOUNT_ID: string;
}

interface ZohoTokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
}

export class ZohoApiError extends Error {
	constructor(public status: number, message: string) {
		super(message);
		this.name = "ZohoApiError";
	}
}

/**
 * Custom fetch wrapper that retries on transient errors (429 and 5xx).
 */
export async function fetchWithRetry(
	url: string | URL,
	init?: RequestInit,
	maxRetries = 3,
	baseDelayMs = 1000
): Promise<Response> {
	let lastError: any;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const res = await fetch(url, init);
			// Retry on 429 (Too Many Requests) or 5xx server errors
			if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
				if (attempt < maxRetries) {
					const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 100;
					await new Promise((resolve) => setTimeout(resolve, delay));
					continue;
				}
			}
			return res;
		} catch (err) {
			lastError = err;
			if (attempt < maxRetries) {
				const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 100;
				await new Promise((resolve) => setTimeout(resolve, delay));
				continue;
			}
		}
	}
	throw lastError || new Error(`Request failed after ${maxRetries} retries`);
}

// Cache tokens in memory to avoid token refresh requests on every tool call.
// Map key: refresh_token, value: { accessToken: string, expiresAt: number }
const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

export function clearCachedToken(refreshToken: string): void {
	tokenCache.delete(refreshToken);
}

export async function getAccessToken(env: ZohoEnv): Promise<string> {
	const cacheKey = env.ZOHO_REFRESH_TOKEN;
	const cached = tokenCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.accessToken;
	}

	const res = await fetchWithRetry(ZOHO_ACCOUNTS_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			refresh_token: env.ZOHO_REFRESH_TOKEN,
			client_id: env.ZOHO_CLIENT_ID,
			client_secret: env.ZOHO_CLIENT_SECRET,
			grant_type: "refresh_token",
		}),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new ZohoApiError(res.status, `Failed to get Zoho access token: ${text}`);
	}

	const data = (await res.json()) as ZohoTokenResponse;
	tokenCache.set(cacheKey, {
		accessToken: data.access_token,
		expiresAt: Date.now() + data.expires_in * 1000 - 60000, // 1 minute buffer
	});
	return data.access_token;
}

function authHeaders(token: string): Record<string, string> {
	return { Authorization: `Zoho-oauthtoken ${token}` };
}

export interface EmailSummary {
	messageId: string;
	subject: string;
	sender: string;
	fromAddress: string;
	toAddress: string;
	ccAddress: string;
	folderId: string;
	receivedTime: string;
	summary: string;
	hasAttachment: string;
}

export async function searchEmails(
	token: string,
	accountId: string,
	searchKey: string,
	limit = 10
): Promise<EmailSummary[]> {
	const url = new URL(`${ZOHO_MAIL_BASE}/accounts/${accountId}/messages/search`);
	url.searchParams.set("searchKey", searchKey);
	url.searchParams.set("limit", String(limit));

	const res = await fetchWithRetry(url.toString(), { headers: authHeaders(token) });
	if (!res.ok) {
		const text = await res.text();
		throw new ZohoApiError(res.status, `Search failed: ${text}`);
	}

	const json = (await res.json()) as { data: EmailSummary[] };
	return json.data ?? [];
}

export interface EmailContent {
	messageId: string;
	content: string;
}

export async function getEmailContent(
	token: string,
	accountId: string,
	folderId: string,
	messageId: string
): Promise<EmailContent> {
	const url = `${ZOHO_MAIL_BASE}/accounts/${accountId}/folders/${folderId}/messages/${messageId}/content`;
	const res = await fetchWithRetry(url, { headers: authHeaders(token) });
	if (!res.ok) {
		const text = await res.text();
		throw new ZohoApiError(res.status, `Failed to get email content: ${text}`);
	}

	const json = (await res.json()) as { data: EmailContent };
	return json.data;
}

export interface EmailDetails {
	messageId: string;
	subject: string;
	sender: string;
	fromAddress: string;
	toAddress: string;
	ccAddress: string;
	folderId: string;
	sentDateInGMT: string;
	summary: string;
}

export async function getEmailDetails(
	token: string,
	accountId: string,
	folderId: string,
	messageId: string
): Promise<EmailDetails> {
	const url = `${ZOHO_MAIL_BASE}/accounts/${accountId}/folders/${folderId}/messages/${messageId}/details`;
	const res = await fetchWithRetry(url, { headers: authHeaders(token) });
	if (!res.ok) {
		const text = await res.text();
		throw new ZohoApiError(res.status, `Failed to get email details: ${text}`);
	}

	const json = (await res.json()) as { data: EmailDetails };
	return json.data;
}

export async function getEmailHeaders(
	token: string,
	accountId: string,
	folderId: string,
	messageId: string
): Promise<string> {
	const url = `${ZOHO_MAIL_BASE}/accounts/${accountId}/folders/${folderId}/messages/${messageId}/header`;
	const res = await fetchWithRetry(url, { headers: authHeaders(token) });
	if (!res.ok) {
		const text = await res.text();
		throw new ZohoApiError(res.status, `Failed to get email headers: ${text}`);
	}

	const json = (await res.json()) as { data: { headerContent: string } };
	return json.data.headerContent;
}

export function extractRfcMessageId(headerContent: string): string | null {
	const match = headerContent.match(/^Message-ID:\s*(<[^>\s]+>)/im);
	return match ? match[1].trim() : null;
}

/** Extract a (possibly line-folded) header's raw value by name. */
export function extractHeaderValue(headerContent: string, name: string): string | null {
	// Capture the value across RFC 5322 folded continuation lines (lines starting with whitespace).
	const re = new RegExp(`^${name}:\\s*([\\s\\S]*?)(?=\\n[^\\s]|$)`, "im");
	const m = headerContent.match(re);
	return m ? m[1].trim() : null;
}

/** Pull all <message-id> tokens out of a header value, in order. */
function extractMessageIds(value: string | null): string[] {
	if (!value) return [];
	return value.match(/<[^>\s]+>/g) ?? [];
}

/**
 * Build the headers needed to reply within a thread exactly like the web UI:
 *  - inReplyTo: the Message-ID of the email being replied to
 *  - refHeader: the full thread chain (original's References + its own Message-ID),
 *    space-separated in chronological order, deduped — matching RFC 5322 References.
 */
export function buildReplyHeaders(headerContent: string): {
	inReplyTo: string | null;
	refHeader: string | null;
} {
	const msgId = extractRfcMessageId(headerContent);
	const refs = extractMessageIds(extractHeaderValue(headerContent, "References"));
	const inReplyToHdr = extractMessageIds(extractHeaderValue(headerContent, "In-Reply-To"));

	const chain: string[] = [];
	for (const id of [...refs, ...inReplyToHdr, ...(msgId ? [msgId] : [])]) {
		if (!chain.includes(id)) chain.push(id);
	}

	return {
		inReplyTo: msgId,
		refHeader: chain.length ? chain.join(" ") : null,
	};
}

/**
 * Read the thread headers already present on a message (e.g. a reply draft),
 * so they can be carried over verbatim when the draft is re-saved. Returns the
 * draft's own In-Reply-To and References, NOT a reply derived from it.
 */
export function extractThreadHeaders(headerContent: string): {
	inReplyTo: string | null;
	refHeader: string | null;
} {
	const inReplyTo = extractMessageIds(extractHeaderValue(headerContent, "In-Reply-To"));
	const refs = extractMessageIds(extractHeaderValue(headerContent, "References"));
	return {
		inReplyTo: inReplyTo[0] ?? null,
		refHeader: refs.length ? refs.join(" ") : null,
	};
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function unescapeHtml(s: string): string {
	return s
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/**
 * Build a reply body that matches the Zoho web UI: the new reply text on top,
 * a separator rule, a From/To/Date/Subject header block, then the original
 * message quoted in a blockquote. (Signature is intentionally not added.)
 */
export function buildQuotedReplyHtml(opts: {
	replyBodyHtml: string;
	fromName: string;
	fromAddr: string;
	to: string;
	date: string;
	subject: string;
	originalBodyHtml: string;
}): string {
	const fromName = escapeHtml(unescapeHtml(opts.fromName || ""));
	const fromAddr = escapeHtml(opts.fromAddr || "");
	const to = escapeHtml(unescapeHtml(opts.to || ""));
	const subject = escapeHtml(unescapeHtml(opts.subject || ""));
	const date = escapeHtml(opts.date || "");

	return (
		`<div><div style="font-family: Verdana, Arial, Helvetica, sans-serif; font-size: 10pt">` +
		`<div>${opts.replyBodyHtml}</div>` +
		`<div><br></div>` +
		`<div class="zmail_extra_hr" style="border-top: 1px solid rgb(204, 204, 204); min-height: 0px; margin-top: 10px; margin-bottom: 10px; line-height: 0px"><br></div>` +
		`<div class="zmail_extra"><div><br></div><div>` +
		`From: ${fromName} &lt;<a href="mailto:${fromAddr}" target="_blank">${fromAddr}</a>&gt;<br>` +
		`To: ${to}<br>` +
		`Date: ${date}<br>` +
		`Subject: ${subject}<br></div>` +
		`<div><br></div>` +
		`<blockquote style="margin: 0px">${opts.originalBodyHtml}</blockquote>` +
		`</div><div><br></div>` +
		`</div></div>`
	);
}

export interface AttachmentInfo {
	attachmentId: string;
	attachmentName: string;
	attachmentSize: string;
	isInline: string;
}

export async function getAttachmentList(
	token: string,
	accountId: string,
	folderId: string,
	messageId: string
): Promise<AttachmentInfo[]> {
	const url = `${ZOHO_MAIL_BASE}/accounts/${accountId}/folders/${folderId}/messages/${messageId}/attachmentinfo`;
	const res = await fetchWithRetry(url, { headers: authHeaders(token) });
	if (!res.ok) {
		const text = await res.text();
		throw new ZohoApiError(res.status, `Failed to get attachment info: ${text}`);
	}

	const json = (await res.json()) as {
		data?: {
			attachments?: any[];
			inlineAttachments?: any[];
		};
	};

	const attachments = json.data?.attachments ?? [];
	return attachments.map((att: any) => ({
		attachmentId: String(att.attachmentId ?? att.attachmentID ?? ""),
		attachmentName: String(att.attachmentName ?? ""),
		attachmentSize: String(att.attachmentSize ?? "0"),
		isInline: String(att.isInline ?? "false"),
	}));
}

export async function downloadAttachment(
	token: string,
	accountId: string,
	folderId: string,
	messageId: string,
	attachmentId: string
): Promise<string> {
	const url = `${ZOHO_MAIL_BASE}/accounts/${accountId}/folders/${folderId}/messages/${messageId}/attachments/${attachmentId}`;
	const res = await fetchWithRetry(url, { headers: authHeaders(token) });
	if (!res.ok) {
		const text = await res.text();
		throw new ZohoApiError(res.status, `Failed to download attachment: ${text}`);
	}

	const arrayBuffer = await res.arrayBuffer();
	const uint8Array = new Uint8Array(arrayBuffer);
	let binary = '';
	for (let i = 0; i < uint8Array.byteLength; i++) {
		binary += String.fromCharCode(uint8Array[i]);
	}
	return btoa(binary);
}

export type UploadedAttachmentInfo = {
	storeName: string;
	attachmentName: string;
	attachmentPath: string;
};

export async function uploadAttachment(
	token: string,
	accountId: string,
	fileName: string,
	base64Data: string
): Promise<UploadedAttachmentInfo> {
	const url = new URL(`${ZOHO_MAIL_BASE}/accounts/${accountId}/messages/attachments`);
	url.searchParams.set("fileName", fileName);

	// Convert base64 string to Uint8Array
	const binaryString = atob(base64Data);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}

	const res = await fetchWithRetry(url.toString(), {
		method: "POST",
		headers: {
			...authHeaders(token),
			"Content-Type": "application/octet-stream",
		},
		body: bytes.buffer,
	});

	if (!res.ok) {
		const text = await res.text();
		throw new ZohoApiError(res.status, `Failed to upload attachment: ${text}`);
	}

	const json = (await res.json()) as { data: UploadedAttachmentInfo[] };
	if (!json.data || json.data.length === 0) {
		throw new Error("Upload failed: No data returned from Zoho");
	}
	return json.data[0];
}

export interface DraftParams {
	fromAddress: string;
	toAddress: string;
	subject: string;
	content: string;
	ccAddress?: string;
	bccAddress?: string;
	inReplyTo?: string;
	refHeader?: string;
	attachments?: UploadedAttachmentInfo[];
}

export interface DraftResult {
	messageId: string;
	mailId: string;
	subject: string;
	fromAddress: string;
	toAddress: string;
	ccAddress?: string;
}

export async function saveDraft(
	token: string,
	accountId: string,
	params: DraftParams
): Promise<DraftResult> {
	const url = `${ZOHO_MAIL_BASE}/accounts/${accountId}/messages`;
	const body: any = {
		fromAddress: params.fromAddress,
		toAddress: params.toAddress,
		mode: "draft", // HARDCODED — this server can NEVER send
		subject: params.subject,
		content: params.content,
		mailFormat: "html",
	};

	if (params.ccAddress) body.ccAddress = params.ccAddress;
	if (params.bccAddress) body.bccAddress = params.bccAddress;
	if (params.inReplyTo) body.inReplyTo = params.inReplyTo;
	if (params.refHeader) body.refHeader = params.refHeader;
	if (params.attachments && params.attachments.length > 0) {
		body.attachments = params.attachments;
	}

	const res = await fetchWithRetry(url, {
		method: "POST",
		headers: {
			...authHeaders(token),
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new ZohoApiError(res.status, `Failed to save draft: ${text}`);
	}

	const json = (await res.json()) as { data: DraftResult };
	return json.data;
}

export interface FolderInfo {
	folderId: string;
	folderName: string;
}

export async function getFolders(token: string, accountId: string): Promise<FolderInfo[]> {
	const url = `${ZOHO_MAIL_BASE}/accounts/${accountId}/folders`;
	const res = await fetchWithRetry(url, { headers: authHeaders(token) });
	if (!res.ok) {
		const text = await res.text();
		throw new ZohoApiError(res.status, `Failed to get folders: ${text}`);
	}

	const json = (await res.json()) as { data: FolderInfo[] };
	return json.data ?? [];
}

export async function listEmails(
	token: string,
	accountId: string,
	folderId: string,
	limit = 10
): Promise<EmailSummary[]> {
	const url = new URL(`${ZOHO_MAIL_BASE}/accounts/${accountId}/messages/view`);
	url.searchParams.set("folderId", folderId);
	url.searchParams.set("limit", String(limit));

	const res = await fetchWithRetry(url.toString(), { headers: authHeaders(token) });
	if (!res.ok) {
		const text = await res.text();
		throw new ZohoApiError(res.status, `Failed to list emails: ${text}`);
	}

	const json = (await res.json()) as { data: EmailSummary[] };
	return json.data ?? [];
}

/**
 * Delete an email (moves it to Trash). Used by delete_draft, and internally by
 * edit_draft to remove the old draft. Requires the ZohoMail.messages.DELETE scope.
 */
export async function deleteEmail(
	token: string,
	accountId: string,
	folderId: string,
	messageId: string
): Promise<void> {
	const url = `${ZOHO_MAIL_BASE}/accounts/${accountId}/folders/${folderId}/messages/${messageId}`;
	const res = await fetchWithRetry(url, { method: "DELETE", headers: authHeaders(token) });
	if (!res.ok) {
		const text = await res.text();
		throw new ZohoApiError(res.status, `Failed to delete email: ${text}`);
	}
}
