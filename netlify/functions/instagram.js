const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return response(200, { success: true });
  }

  if (event.httpMethod !== "POST") {
    return response(405, {
      success: false,
      message: "Only POST method is allowed."
    });
  }

  try {
    const body = parseBody(event.body);
    const inputUrl = body.url || body.link || body.instagram_url;

    const normalized = normalizeInstagramUrl(inputUrl);

    if (!normalized.ok) {
      return response(400, {
        success: false,
        message: normalized.message
      });
    }

    const pageResult = await fetchInstagramPage(normalized.canonicalUrl);

    if (!pageResult.ok) {
      return response(pageResult.status || 502, {
        success: false,
        message: pageResult.message
      });
    }

    const media = extractMedia(pageResult.html, normalized.type);

    if (!media.ok) {
      return response(422, {
        success: false,
        message: media.message
      });
    }

    return response(200, {
      success: true,
      type: media.type,
      media_url: media.url,
      video_url: media.type === "video" ? media.url : "",
      image_url: media.type === "image" ? media.url : "",
      thumbnail_url: media.thumbnail_url || "",
      source_url: normalized.canonicalUrl,
      shortcode: normalized.shortcode
    });
  } catch (error) {
    return response(500, {
      success: false,
      message: error.message || "Server error."
    });
  }
};

function response(statusCode, data) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(data)
  };
}

function parseBody(rawBody) {
  if (!rawBody) return {};

  try {
    return JSON.parse(rawBody);
  } catch (e) {
    const params = new URLSearchParams(rawBody);
    return Object.fromEntries(params.entries());
  }
}

function normalizeInstagramUrl(input) {
  if (!input || typeof input !== "string") {
    return {
      ok: false,
      message: "Instagram URL is required."
    };
  }

  let url = input.trim();

  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url.replace(/^\/+/, "");
  }

  let parsed;

  try {
    parsed = new URL(url);
  } catch (e) {
    return {
      ok: false,
      message: "Invalid URL."
    };
  }

  const host = parsed.hostname.toLowerCase();

  const allowedHosts = [
    "instagram.com",
    "www.instagram.com",
    "m.instagram.com",
    "instagr.am",
    "www.instagr.am"
  ];

  if (!allowedHosts.includes(host)) {
    return {
      ok: false,
      message: "Only Instagram URLs are supported."
    };
  }

  const match = parsed.pathname.match(/^\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);

  if (!match) {
    return {
      ok: false,
      message: "Only Instagram post, reel, and TV links are supported."
    };
  }

  const type = match[1];
  const shortcode = match[2];

  return {
    ok: true,
    type,
    shortcode,
    canonicalUrl: `https://www.instagram.com/${type}/${shortcode}/`
  };
}

async function fetchInstagramPage(url) {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      }
    });

    const html = await res.text();

    if (res.status === 404) {
      return {
        ok: false,
        status: 404,
        message: "Instagram link was not found."
      };
    }

    if (res.status === 429) {
      return {
        ok: false,
        status: 429,
        message: "Instagram is rate-limiting requests. Try again later."
      };
    }

    if (!res.ok || !html) {
      return {
        ok: false,
        status: 502,
        message: "Could not fetch Instagram page."
      };
    }

    return {
      ok: true,
      html
    };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      message: "Instagram fetch failed."
    };
  }
}

function extractMedia(html, permalinkType) {
  if (/private account|this account is private/i.test(html)) {
    return {
      ok: false,
      message: "Private Instagram content is not supported."
    };
  }

  const thumbnail =
    findMeta(html, ["og:image", "twitter:image"]) ||
    findJsonUrl(html, ["display_url", "thumbnail_src", "thumbnailUrl", "thumbnail_url"]);

  let video =
    findMeta(html, [
      "og:video",
      "og:video:secure_url",
      "twitter:player:stream"
    ]) ||
    findJsonUrl(html, [
      "video_url",
      "playable_url",
      "playable_url_quality_hd",
      "contentUrl",
      "content_url",
      "download_url",
      "media_url"
    ]) ||
    findVideoUrlDeep(html);

  if (video && isAllowedMediaHost(video)) {
    return {
      ok: true,
      type: "video",
      url: video,
      thumbnail_url: thumbnail || ""
    };
  }

  if (permalinkType === "reel" || permalinkType === "tv") {
    return {
      ok: false,
      message:
        "The reel video URL was not found. Instagram only returned thumbnail or blocked server access."
    };
  }

  if (thumbnail && isAllowedMediaHost(thumbnail)) {
    return {
      ok: true,
      type: "image",
      url: thumbnail,
      thumbnail_url: thumbnail
    };
  }

  return {
    ok: false,
    message: "No public downloadable media URL was found."
  };
}

function findMeta(html, wantedNames) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const property = getAttr(tag, "property");
    const name = getAttr(tag, "name");
    const content = getAttr(tag, "content");

    const metaName = (property || name || "").toLowerCase();

    if (!content) continue;

    if (wantedNames.map((x) => x.toLowerCase()).includes(metaName)) {
      return cleanUrl(content);
    }
  }

  return "";
}

function getAttr(tag, attrName) {
  const regex = new RegExp(`${attrName}\\s*=\\s*["']([^"']+)["']`, "i");
  const match = tag.match(regex);
  return match ? decodeHtml(match[1]) : "";
}

function findJsonUrl(html, keys) {
  for (const key of keys) {
    const patterns = [
      new RegExp(`"${escapeRegex(key)}"\\s*:\\s*"([^"]+)"`, "i"),
      new RegExp(`\\\\"${escapeRegex(key)}\\\\"\\s*:\\s*\\\\"([^"]+)\\\\"`, "i")
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);

      if (match && match[1]) {
        const url = cleanUrl(match[1]);

        if (url && /^https?:\/\//i.test(url)) {
          return url;
        }
      }
    }
  }

  return "";
}

function findVideoUrlDeep(html) {
  const candidates = [];

  const decoded = decodeHtml(html)
    .replace(/\\u0026/g, "&")
    .replace(/\\u003d/g, "=")
    .replace(/\\u003f/g, "?")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"');

  const mp4Regex = /https?:\/\/[^"'<>\s]+\.mp4[^"'<>\s]*/gi;
  const matches = decoded.match(mp4Regex) || [];

  for (const match of matches) {
    candidates.push(match);
  }

  const jsonUrlRegex = /"[^"]*(video|playable|download|media)[^"]*"\s*:\s*"([^"]+)"/gi;
  let jsonMatch;

  while ((jsonMatch = jsonUrlRegex.exec(decoded)) !== null) {
    if (jsonMatch[2]) {
      candidates.push(jsonMatch[2]);
    }
  }

  for (const candidate of candidates) {
    const url = cleanUrl(candidate);

    if (url && isAllowedMediaHost(url) && looksLikeVideo(url)) {
      return url;
    }
  }

  return "";
}

function cleanUrl(url) {
  if (!url || typeof url !== "string") return "";

  let cleaned = decodeHtml(url);

  cleaned = cleaned
    .replace(/\\u0026/g, "&")
    .replace(/\\u003d/g, "=")
    .replace(/\\u003f/g, "?")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/\\/g, "")
    .trim();

  try {
    const parsed = new URL(cleaned);
    return parsed.toString();
  } catch (e) {
    return "";
  }
}

function decodeHtml(str) {
  if (!str || typeof str !== "string") return "";

  return str
    .replace(/&amp;/g, "&")
    .replace(/&#x26;/g, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function isAllowedMediaHost(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    const allowedSuffixes = [
      "cdninstagram.com",
      "fbcdn.net",
      "fbsbx.com",
      "instagram.com"
    ];

    return allowedSuffixes.some((suffix) => {
      return host === suffix || host.endsWith("." + suffix);
    });
  } catch (e) {
    return false;
  }
}

function looksLikeVideo(url) {
  return /\.mp4(\?|$)/i.test(url) || /video/i.test(url);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
