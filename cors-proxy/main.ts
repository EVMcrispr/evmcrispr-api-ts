// Configuration
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*"; // Allow all origins
const ALLOWED_TARGET_DOMAINS: string[] = Deno.env.get("ALLOWED_TARGET_DOMAINS")?.split(",") || []; // Leave empty to allow any domain (less secure)

const ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS, PATCH";
const ALLOWED_HEADERS = "Content-Type, Authorization, X-Requested-With, X-CSRF-Token";

function isDomainAllowed(url: string): boolean {
  if (ALLOWED_TARGET_DOMAINS.length === 0) {
    return true; // Allow all if not configured
  }
  try {
    const hostname = new URL(url).hostname;
    return ALLOWED_TARGET_DOMAINS.some(domain => 
        hostname === domain || hostname.endsWith("." + domain)
    );
  } catch {
    return false; // Invalid URL
  }
}

async function handler(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);

  // 1. Handle OPTIONS (preflight) requests
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204, // No Content
      headers: {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": ALLOWED_METHODS,
        "Access-Control-Allow-Headers": ALLOWED_HEADERS,
        "Access-Control-Max-Age": "86400", // Cache preflight for 1 day
      },
    });
  }

  // 2. Validate target URL


  // Extract target URL from path
  const prefix = "/v0/";
  const path = decodeURIComponent(requestUrl.pathname);
  if (!path.startsWith(prefix)) {
    return new Response("Not Found", { status: 404 });
  }

  // Combine the path after prefix with any query string
  // This handles URLs like /v0/https://api.example.com/path?param=value
  // where ?param=value gets parsed as the proxy request's search params
  const targetUrlString = path.slice(prefix.length) + requestUrl.search;

  let targetUrl: URL;
  try {
    targetUrl = new URL(targetUrlString);
  } catch (_) {
    return new Response("Invalid 'url' query parameter.", {
      status: 400,
      headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": ALLOWED_ORIGIN },
    });
  }

  // 2a. Optional: Check if target domain is allowed
  if (!isDomainAllowed(targetUrl.toString())) {
    console.warn(`Blocked proxy request to disallowed domain: ${targetUrl.hostname}`);
    return new Response(`Proxying to domain ${targetUrl.hostname} is not allowed.`, {
      status: 403, // Forbidden
      headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": ALLOWED_ORIGIN },
    });
  }

  // 3. Prepare request to the target API
  const proxyHeaders = new Headers(request.headers);
  // Remove headers that are specific to the proxy request or set by the environment
  proxyHeaders.delete("host"); // Will be set by fetch based on targetUrl
  proxyHeaders.delete("origin"); // Let the target API see the proxy as origin if needed
  proxyHeaders.delete("referer"); // Usually not relevant for API calls
  // Deno Deploy/fetch might add its own, e.g., X-Forwarded-For. Be mindful.

  try {
    // 4. Fetch from target API
    const targetResponse = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: proxyHeaders,
      body: request.body, // Pass through the request body
      redirect: "follow", // Or 'manual' if you want to handle redirects yourself
    });

    // 5. Create new response headers, copying from target and adding CORS
    const responseHeaders = new Headers(targetResponse.headers);
    responseHeaders.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    responseHeaders.set("Access-Control-Allow-Methods", ALLOWED_METHODS); // Good to reiterate
    responseHeaders.set("Access-Control-Allow-Headers", ALLOWED_HEADERS); // Good to reiterate

    // Allow client to access specific headers from the response if needed
    // responseHeaders.set("Access-Control-Expose-Headers", "Content-Length, X-My-Custom-Header");

    // 6. Send response back to client (stream body for efficiency)
    return new Response(targetResponse.body, {
      status: targetResponse.status,
      statusText: targetResponse.statusText,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error(`[CORS Proxy] Error fetching ${targetUrlString}:`, error);
    let message = "Error fetching remote URL.";
    let status = 502; // Bad Gateway

    if (error instanceof TypeError && error.message.includes("invalid URL")) {
      message = "Invalid URL provided to proxy.";
      status = 400;
    } else if (error.message.includes("Failed to fetch") || error.message.includes("unreachable") || error.message.includes("timeout")) {
      message = "Remote URL is unreachable or timed out.";
      status = 504; // Gateway Timeout
    }
    // Avoid leaking too much internal error detail to the client
    return new Response(message, {
      status: status,
      headers: {
        "Content-Type": "text/plain",
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      },
    });
  }
}

Deno.serve(handler);
