const params = new URLSearchParams(window.location.search);
const fileId = params.get("id");

const titleEl = document.getElementById("doc-title");
const subTitleEl = document.getElementById("doc-subtitle");
const statusEl = document.getElementById("editor-status");
const toggleChromeButton = document.getElementById("toggle-chrome");

let docEditor;
let rewriteInstalled = false;
let isChromeHidden = false;

if (!fileId) {
  setStatus("문서 ID가 없습니다. 목록으로 돌아가서 다시 시도해 주세요.");
} else {
  void loadEditor(fileId);
}

if (toggleChromeButton) {
  toggleChromeButton.addEventListener("click", () => {
    isChromeHidden = !isChromeHidden;
    document.body.classList.toggle("chrome-hidden", isChromeHidden);
    toggleChromeButton.textContent = isChromeHidden ? "헤더 보이기" : "헤더 숨기기";
  });
}

async function loadEditor(id) {
  try {
    setStatus("편집기 설정을 불러오는 중...");

    const response = await fetch(`/api/editor-config/${encodeURIComponent(id)}`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "편집기 설정 조회 실패");
    }

    titleEl.textContent = payload.file.originalName;
    subTitleEl.textContent = `유형: ${payload.file.documentType} (.${payload.file.extension})`;

    installDocumentServerUrlRewrite();
    const documentServerCandidates = buildDocumentServerCandidates(payload.documentServerPublicUrl);
    const selectedDocumentServerUrl = await loadDocumentServerApi(documentServerCandidates);

    setStatus(
      `편집기 로딩 완료 (${selectedDocumentServerUrl}). 변경사항은 자동 저장되며 서버 콜백으로 파일에 반영됩니다.`,
    );

    payload.config.width = "100%";
    payload.config.height = "100%";
    docEditor = new window.DocsAPI.DocEditor("editor-holder", payload.config);
  } catch (error) {
    setStatus(`오류: ${error.message}`);
  }
}

function loadDocumentServerApi(candidates) {
  const bases = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (window.DocsAPI && window.DocsAPI.DocEditor) {
    return Promise.resolve(bases[0] || `${window.location.origin}/ds`);
  }
  if (bases.length === 0) {
    return Promise.reject(new Error("문서 서버 경로가 비어 있습니다."));
  }

  return new Promise((resolve, reject) => {
    let idx = 0;

    const tryNext = () => {
      if (idx >= bases.length) {
        reject(new Error("ONLYOFFICE Document Server 스크립트를 로드하지 못했습니다."));
        return;
      }

      const baseUrl = bases[idx++];
      setStatus(`문서 서버 연결 시도: ${baseUrl}`);

      const script = document.createElement("script");
      script.src = `${baseUrl}/web-apps/apps/api/documents/api.js?ts=${Date.now()}`;
      script.async = true;

      script.onload = () => resolve(baseUrl);
      script.onerror = () => {
        script.remove();
        tryNext();
      };

      document.head.appendChild(script);
    };

    tryNext();
  });
}

function normalizeDocumentServerUrl(rawUrl) {
  const fallback = `${window.location.origin}/ds`;
  if (!rawUrl || typeof rawUrl !== "string") {
    return fallback;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl, window.location.origin);
  } catch {
    return fallback;
  }

  const currentHost = window.location.hostname;
  const docHost = parsed.hostname;
  const currentIsLoopback = isLoopbackHost(currentHost);
  const docIsLoopback = isLoopbackHost(docHost);

  // Remote access + localhost docserver URL means the browser points to itself and fails.
  if (docIsLoopback && !currentIsLoopback) {
    parsed.protocol = window.location.protocol;
    parsed.hostname = currentHost;
    if (window.location.port && parsed.port === "8082") {
      // Keep explicit docserver port for non-proxy URLs.
      parsed.port = "8082";
    }
  }

  return parsed.toString().replace(/\/$/, "");
}

function buildDocumentServerCandidates(rawUrl) {
  const candidates = [];
  const normalized = normalizeDocumentServerUrl(rawUrl);
  if (normalized) {
    candidates.push(normalized);
  }
  const originFallback = `${window.location.origin}/ds`;
  if (!candidates.includes(originFallback)) {
    candidates.push(originFallback);
  }
  return candidates;
}

function installDocumentServerUrlRewrite() {
  if (rewriteInstalled) {
    return;
  }
  rewriteInstalled = true;

  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (originalFetch) {
    window.fetch = (input, init) => {
      if (typeof input === "string") {
        return originalFetch(rewriteKnownInternalHost(input), init);
      }
      if (input instanceof Request) {
        const rewrittenUrl = rewriteKnownInternalHost(input.url);
        if (rewrittenUrl !== input.url) {
          return originalFetch(new Request(rewrittenUrl, input), init);
        }
      }
      return originalFetch(input, init);
    };
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR) {
    const originalOpen = OriginalXHR.prototype.open;
    OriginalXHR.prototype.open = function patchedOpen(method, url, ...rest) {
      const nextUrl = typeof url === "string" ? rewriteKnownInternalHost(url) : url;
      return originalOpen.call(this, method, nextUrl, ...rest);
    };
  }

  const OriginalWebSocket = window.WebSocket;
  if (OriginalWebSocket) {
    window.WebSocket = function PatchedWebSocket(url, protocols) {
      const nextUrl = typeof url === "string" ? rewriteKnownInternalHost(url) : url;
      return protocols ? new OriginalWebSocket(nextUrl, protocols) : new OriginalWebSocket(nextUrl);
    };
    window.WebSocket.prototype = OriginalWebSocket.prototype;
  }
}

function rewriteKnownInternalHost(urlValue) {
  let parsed;
  try {
    parsed = new URL(urlValue, window.location.origin);
  } catch {
    return urlValue;
  }

  const internalHosts = new Set(["documentserver", "app"]);
  if (!internalHosts.has(parsed.hostname)) {
    return urlValue;
  }

  parsed.protocol = window.location.protocol;
  parsed.host = window.location.host;
  return parsed.toString();
}

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function setStatus(message) {
  statusEl.textContent = message;
}

window.addEventListener("beforeunload", () => {
  if (docEditor && typeof docEditor.destroyEditor === "function") {
    docEditor.destroyEditor();
  }
});
