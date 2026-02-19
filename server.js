const crypto = require("crypto");
const fs = require("fs/promises");
const fss = require("fs");
const os = require("os");
const path = require("path");
const { pipeline } = require("stream/promises");

const axios = require("axios");
const dotenv = require("dotenv");
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const jwt = require("jsonwebtoken");
const mime = require("mime-types");
const multer = require("multer");

dotenv.config();

const app = express();

const PORT = parseInt(process.env.PORT || "3000", 10);
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || path.join(__dirname, "data", "files"));
const TMP_UPLOAD_DIR = path.join(STORAGE_DIR, ".tmp");
const INDEX_FILE = path.join(STORAGE_DIR, "index.json");
const MAX_UPLOAD_SIZE_MB = parseInt(process.env.MAX_UPLOAD_SIZE_MB || "200", 10);
const JWT_SECRET = process.env.JWT_SECRET || "replace-me";
const JWT_ENABLED = (process.env.JWT_ENABLED || "true").toLowerCase() !== "false";

const PUBLIC_BASE_URL = stripTrailingSlash(
  process.env.PUBLIC_BASE_URL || process.env.BASE_URL || `http://localhost:${PORT}`,
);
const INTERNAL_BASE_URL = stripTrailingSlash(process.env.INTERNAL_BASE_URL || PUBLIC_BASE_URL);
const DOCUMENT_SERVER_PUBLIC_URL = stripTrailingSlash(
  process.env.DOCUMENT_SERVER_PUBLIC_URL || process.env.DOCUMENT_SERVER_URL || "",
);
const DOCUMENT_SERVER_INTERNAL_URL = stripTrailingSlash(
  process.env.DOCUMENT_SERVER_INTERNAL_URL || "http://localhost:8082",
);
const DOCUMENT_SERVER_PROXY_PATH = normalizeProxyPath(process.env.DOCUMENT_SERVER_PROXY_PATH || "/ds");
const DOCSERVER_VERSIONED_WEBAPPS_PATH_RE = /^\/\d+\.\d+\.\d+-[a-z0-9]+\/web-apps\//i;
const DOCSERVER_ROOT_PROXY_PREFIXES = [
  "/cache",
  "/web-apps",
  "/sdkjs",
  "/fonts",
  "/dictionaries",
  "/plugins",
  "/welcome",
  "/healthcheck",
];

const SUPPORTED_EXTENSIONS = new Set([
  "doc",
  "docm",
  "docx",
  "dot",
  "dotm",
  "dotx",
  "epub",
  "fodt",
  "hwp",
  "hwpx",
  "html",
  "htm",
  "mht",
  "odt",
  "ott",
  "pdf",
  "rtf",
  "txt",
  "xps",
  "xml",
  "csv",
  "fods",
  "ods",
  "ots",
  "xls",
  "xlsm",
  "xlsx",
  "xlt",
  "xltm",
  "xltx",
  "odp",
  "otp",
  "pot",
  "potm",
  "potx",
  "pps",
  "ppsm",
  "ppsx",
  "ppt",
  "pptm",
  "pptx",
]);

const WORD_EXTENSIONS = new Set([
  "doc",
  "docm",
  "docx",
  "dot",
  "dotm",
  "dotx",
  "epub",
  "fodt",
  "hwp",
  "hwpx",
  "html",
  "htm",
  "mht",
  "odt",
  "ott",
  "rtf",
  "txt",
  "xml",
]);
const CELL_EXTENSIONS = new Set(["csv", "fods", "ods", "ots", "xls", "xlsm", "xlsx", "xlt", "xltm", "xltx"]);
const SLIDE_EXTENSIONS = new Set([
  "odp",
  "otp",
  "pot",
  "potm",
  "potx",
  "pps",
  "ppsm",
  "ppsx",
  "ppt",
  "pptm",
  "pptx",
]);
const PDF_EXTENSIONS = new Set(["pdf", "xps"]);

const upload = multer({
  dest: TMP_UPLOAD_DIR,
  limits: {
    fileSize: MAX_UPLOAD_SIZE_MB * 1024 * 1024,
  },
});

app.set("trust proxy", true);
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: false }));
const docServerProxyStrip = buildDocServerProxy({ stripProxyPrefix: true });
const docServerProxyPassthrough = buildDocServerProxy({ stripProxyPrefix: false });
app.use((req, res, next) => {
  if (startsWithPath(req.path, DOCUMENT_SERVER_PROXY_PATH)) {
    return docServerProxyStrip(req, res, next);
  }
  if (DOCSERVER_ROOT_PROXY_PREFIXES.some((prefix) => startsWithPath(req.path, prefix))) {
    return docServerProxyPassthrough(req, res, next);
  }
  if (DOCSERVER_VERSIONED_WEBAPPS_PATH_RE.test(req.path)) {
    return docServerProxyPassthrough(req, res, next);
  }
  return next();
});
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", async (_req, res) => {
  const index = await loadIndex();
  res.json({
    ok: true,
    fileCount: index.length,
    storageDir: STORAGE_DIR,
    documentServerPublicUrl: resolveDocumentServerPublicUrl(_req),
    jwtEnabled: JWT_ENABLED,
  });
});

app.get("/api/files", async (_req, res, next) => {
  try {
    const index = await loadIndex();
    const list = [];

    for (const item of index) {
      const normalizedItem = normalizeEntryName(item);
      const filePath = path.join(STORAGE_DIR, item.storedName);
      if (!(await exists(filePath))) {
        continue;
      }
      list.push({
        ...normalizedItem,
        documentType: getDocumentType(item.extension),
        openUrl: `/editor.html?id=${normalizedItem.id}`,
        downloadUrl: `/api/files/${normalizedItem.id}/download`,
      });
    }

    list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    res.json(list);
  } catch (error) {
    next(error);
  }
});

app.post("/api/upload", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "파일이 없습니다." });
    }

    const originalName = normalizeOriginalName(req.file.originalname);
    const extension = getExtension(originalName) || getExtension(req.file.originalname);
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(400).json({
        error: `지원하지 않는 확장자입니다: .${extension || "(none)"}`,
      });
    }

    const id = crypto.randomUUID();
    const safeBaseName = sanitizeBaseName(path.basename(originalName, path.extname(originalName)));
    const storedName = `${id}_${safeBaseName}.${extension}`;
    const finalPath = path.join(STORAGE_DIR, storedName);

    await fs.rename(req.file.path, finalPath);

    const nowIso = new Date().toISOString();
    const entry = {
      id,
      originalName,
      storedName,
      extension,
      size: req.file.size,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const index = await loadIndex();
    index.push(entry);
    await saveIndex(index);

    return res.status(201).json({
      ...entry,
      documentType: getDocumentType(extension),
      openUrl: `/editor.html?id=${id}`,
      downloadUrl: `/api/files/${id}/download`,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/files/:id/download", async (req, res, next) => {
  try {
    const index = await loadIndex();
    const entry = index.find((item) => item.id === req.params.id);
    if (!entry) {
      return res.status(404).json({ error: "파일을 찾을 수 없습니다." });
    }
    const normalizedEntry = normalizeEntryName(entry);

    const filePath = path.join(STORAGE_DIR, entry.storedName);
    if (!(await exists(filePath))) {
      return res.status(404).json({ error: "저장된 파일이 없습니다." });
    }

    const contentType = mime.lookup(normalizedEntry.originalName) || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeRFC5987ValueChars(normalizedEntry.originalName)}`,
    );
    res.sendFile(filePath);
  } catch (error) {
    next(error);
  }
});

app.get("/api/editor-config/:id", async (req, res, next) => {
  try {
    const index = await loadIndex();
    const entry = index.find((item) => item.id === req.params.id);
    if (!entry) {
      return res.status(404).json({ error: "파일을 찾을 수 없습니다." });
    }
    const normalizedEntry = normalizeEntryName(entry);

    const filePath = path.join(STORAGE_DIR, entry.storedName);
    if (!(await exists(filePath))) {
      return res.status(404).json({ error: "저장된 파일이 없습니다." });
    }

    const userId = sanitizeUserField(req.query.userId, "guest");
    const userName = sanitizeUserField(req.query.userName, "게스트");
    const documentType = getDocumentType(entry.extension);
    const docKey = buildDocumentKey(normalizedEntry);

    const browserBaseUrl = resolveBrowserBaseUrl(req);
    const documentServerPublicUrl = resolveDocumentServerPublicUrl(req);
    const config = {
      document: {
        fileType: entry.extension,
        key: docKey,
        title: normalizedEntry.originalName,
        url: `${browserBaseUrl}/api/files/${entry.id}/download`,
        permissions: {
          comment: true,
          copy: true,
          download: true,
          edit: true,
          fillForms: true,
          modifyContentControl: true,
          print: true,
          review: true,
        },
      },
      documentType,
      editorConfig: {
        callbackUrl: `${browserBaseUrl}/api/callback/${entry.id}`,
        coEditing: {
          mode: "fast",
          change: true,
        },
        customization: {
          autosave: true,
          compactToolbar: false,
          forcesave: true,
        },
        lang: "ko",
        mode: "edit",
        user: {
          id: userId,
          name: userName,
        },
      },
      type: "desktop",
    };

    if (JWT_ENABLED) {
      config.token = jwt.sign(config, JWT_SECRET);
    }

    res.json({
      file: {
        ...normalizedEntry,
        documentType,
      },
      documentServerPublicUrl,
      config,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/callback/:id", async (req, res) => {
  try {
    const index = await loadIndex();
    const entry = index.find((item) => item.id === req.params.id);
    if (!entry) {
      return res.json({ error: 0 });
    }

    const { status, url, token } = req.body || {};
    const statusCode = Number(status);

    // https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler/
    // 2,3,6,7 status means a new document state is available for download.
    if ([2, 3, 6, 7].includes(statusCode) && typeof url === "string" && url.length > 0) {
      if (JWT_ENABLED && token) {
        try {
          jwt.verify(token, JWT_SECRET);
        } catch (error) {
          console.warn("ONLYOFFICE callback token verification failed:", error.message);
        }
      }

      const downloadHeaders = {};
      if (JWT_ENABLED && token) {
        downloadHeaders.Authorization = `Bearer ${token}`;
      }

      const response = await axios.get(url, {
        headers: downloadHeaders,
        maxBodyLength: Infinity,
        responseType: "stream",
        timeout: 60_000,
      });

      const tempOutput = path.join(STORAGE_DIR, `${entry.id}.download.tmp`);
      await pipeline(response.data, fss.createWriteStream(tempOutput));

      const targetPath = path.join(STORAGE_DIR, entry.storedName);
      await fs.rename(tempOutput, targetPath);

      const stat = await fs.stat(targetPath);
      entry.size = stat.size;
      entry.updatedAt = new Date().toISOString();
      await saveIndex(index);
    }

    return res.json({ error: 0 });
  } catch (error) {
    console.error("ONLYOFFICE callback processing failed:", error);
    return res.json({ error: 0 });
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: `파일 크기 제한(${MAX_UPLOAD_SIZE_MB}MB)을 초과했습니다.` });
    }
    return res.status(400).json({ error: error.message });
  }

  console.error(error);
  return res.status(500).json({ error: "서버 오류가 발생했습니다." });
});

(async function bootstrap() {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
  await fs.mkdir(TMP_UPLOAD_DIR, { recursive: true });
  if (!(await exists(INDEX_FILE))) {
    await fs.writeFile(INDEX_FILE, "[]\n", "utf8");
  }

  app.listen(PORT, () => {
    console.log(`word_web listening on http://0.0.0.0:${PORT}`);
    console.log(`publicBaseUrl=${PUBLIC_BASE_URL}`);
    console.log(`internalBaseUrl=${INTERNAL_BASE_URL}`);
    console.log(`documentServerInternalUrl=${DOCUMENT_SERVER_INTERNAL_URL}`);
    console.log(`documentServerProxyPath=${DOCUMENT_SERVER_PROXY_PATH}`);
    if (DOCUMENT_SERVER_PUBLIC_URL) {
      console.log(`documentServerPublicUrl=${DOCUMENT_SERVER_PUBLIC_URL}`);
    } else {
      console.log(`documentServerPublicUrl=auto(request-origin + ${DOCUMENT_SERVER_PROXY_PATH})`);
    }
  });
})().catch((error) => {
  console.error("Failed to bootstrap app:", error);
  process.exit(1);
});

async function loadIndex() {
  try {
    const raw = await fs.readFile(INDEX_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveIndex(items) {
  const tempPath = `${INDEX_FILE}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, INDEX_FILE);
}

function getExtension(filename) {
  return path.extname(filename || "").replace(".", "").toLowerCase();
}

function getDocumentType(extension) {
  if (PDF_EXTENSIONS.has(extension)) {
    return "pdf";
  }
  if (CELL_EXTENSIONS.has(extension)) {
    return "cell";
  }
  if (SLIDE_EXTENSIONS.has(extension)) {
    return "slide";
  }
  if (WORD_EXTENSIONS.has(extension)) {
    return "word";
  }
  return "word";
}

function normalizeEntryName(entry) {
  const normalizedName = normalizeOriginalName(entry.originalName);
  if (normalizedName === entry.originalName) {
    return entry;
  }
  return {
    ...entry,
    originalName: normalizedName,
  };
}

function normalizeOriginalName(inputName) {
  const raw = String(inputName || "").trim();
  if (!raw) {
    return "unnamed";
  }

  // If filename already contains non-Latin1 code points, keep it.
  if (/[^\u0000-\u00ff]/u.test(raw)) {
    return raw.normalize("NFC");
  }

  let decoded;
  try {
    decoded = Buffer.from(raw, "latin1").toString("utf8").trim();
  } catch {
    return raw.normalize("NFC");
  }

  if (!decoded) {
    return raw.normalize("NFC");
  }

  const decodedHasWideChars = /[^\u0000-\u00ff]/u.test(decoded);
  const rawHasWideChars = /[^\u0000-\u00ff]/u.test(raw);
  const decodedReplacementCount = (decoded.match(/\uFFFD/g) || []).length;
  const rawReplacementCount = (raw.match(/\uFFFD/g) || []).length;

  if ((decodedHasWideChars && !rawHasWideChars) || decodedReplacementCount < rawReplacementCount) {
    return decoded.normalize("NFC");
  }

  return raw.normalize("NFC");
}

function stripTrailingSlash(value) {
  if (!value) {
    return "";
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeProxyPath(value) {
  const input = String(value || "").trim();
  if (!input || input === "/") {
    return "/ds";
  }
  const withSlash = input.startsWith("/") ? input : `/${input}`;
  return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

function startsWithPath(pathname, prefix) {
  if (pathname === prefix) {
    return true;
  }
  return pathname.startsWith(`${prefix}/`);
}

function sanitizeBaseName(baseName) {
  const safe = String(baseName || "file")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return safe.length > 0 ? safe.slice(0, 80) : "file";
}

function sanitizeUserField(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const safe = value.trim().replace(/[^\w\s\-가-힣]/g, "").slice(0, 32);
  return safe || fallback;
}

function buildDocumentKey(entry) {
  const source = `${entry.id}:${entry.updatedAt}:${entry.size}:${entry.originalName}`;
  return crypto.createHash("sha256").update(source).digest("hex").slice(0, 20);
}

function encodeRFC5987ValueChars(str) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)
    .replace(/%(7C|60|5E)/g, (match) => match.toLowerCase());
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildDocServerProxy({ stripProxyPrefix }) {
  const baseOptions = {
    target: DOCUMENT_SERVER_INTERNAL_URL,
    changeOrigin: false,
    xfwd: true,
    ws: true,
    onProxyReq: (proxyReq, req) => {
      const hostHeader = req.headers.host;
      if (hostHeader) {
        proxyReq.setHeader("Host", hostHeader);
        proxyReq.setHeader("X-Forwarded-Host", hostHeader);
      }
      proxyReq.setHeader("X-Forwarded-Proto", req.protocol || "http");
    },
    onError: (_error, _req, res) => {
      if (!res.headersSent) {
        res.status(502).json({ error: "문서 서버에 연결할 수 없습니다." });
      }
    },
  };

  if (!stripProxyPrefix) {
    return createProxyMiddleware(baseOptions);
  }

  return createProxyMiddleware({
    ...baseOptions,
    pathRewrite: (inputPath) =>
      inputPath.replace(new RegExp(`^${escapeRegExp(DOCUMENT_SERVER_PROXY_PATH)}`), ""),
  });
}

function resolveDocumentServerPublicUrl(req) {
  if (DOCUMENT_SERVER_PUBLIC_URL) {
    return DOCUMENT_SERVER_PUBLIC_URL;
  }

  return `${resolveRequestOrigin(req)}${DOCUMENT_SERVER_PROXY_PATH}`;
}

function resolveBrowserBaseUrl(req) {
  if (PUBLIC_BASE_URL && !isLoopbackHostnameFromUrl(PUBLIC_BASE_URL)) {
    return PUBLIC_BASE_URL;
  }

  const requestOrigin = resolveRequestOrigin(req);
  if (!isLoopbackHostnameFromUrl(requestOrigin)) {
    return requestOrigin;
  }

  const protoFromOrigin = (() => {
    try {
      return new URL(requestOrigin).protocol.replace(":", "");
    } catch {
      return req.protocol || "http";
    }
  })();
  const containerIp = getPrimaryContainerIPv4();
  if (containerIp) {
    return `${protoFromOrigin}://${containerIp}:${PORT}`;
  }

  return requestOrigin;
}

function resolveRequestOrigin(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const protocol = forwardedProto || req.protocol || "http";
  const requestHost = forwardedHost || req.get("host") || `localhost:${PORT}`;

  try {
    const url = new URL(`${protocol}://${requestHost}`);
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return stripTrailingSlash(url.toString());
  } catch {
    return `http://localhost:${PORT}`;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLoopbackHostnameFromUrl(urlValue) {
  try {
    const parsed = new URL(urlValue);
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function getPrimaryContainerIPv4() {
  const networks = os.networkInterfaces();
  const preferredOrder = ["eth0", "ens3", "en0"];

  for (const name of preferredOrder) {
    const entries = networks[name] || [];
    for (const entry of entries) {
      if (entry && entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }

  for (const entries of Object.values(networks)) {
    for (const entry of entries || []) {
      if (entry && entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return "";
}
