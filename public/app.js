const uploadForm = document.getElementById("upload-form");
const fileInput = document.getElementById("file-input");
const uploadStatus = document.getElementById("upload-status");
const listStatus = document.getElementById("list-status");
const rows = document.getElementById("file-rows");
const refreshBtn = document.getElementById("refresh-btn");

refreshBtn.addEventListener("click", () => {
  void loadFiles();
});

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    uploadStatus.textContent = "업로드할 파일을 선택해 주세요.";
    return;
  }

  uploadStatus.textContent = `업로드 중: ${file.name}`;

  const formData = new FormData();
  formData.append("file", file);

  try {
    const response = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "업로드 실패");
    }

    uploadStatus.textContent = `업로드 완료: ${payload.originalName}`;
    fileInput.value = "";
    await loadFiles();
  } catch (error) {
    uploadStatus.textContent = `오류: ${error.message}`;
  }
});

async function loadFiles() {
  listStatus.textContent = "목록 불러오는 중...";
  rows.innerHTML = "";

  try {
    const response = await fetch("/api/files");
    const files = await response.json();

    if (!response.ok) {
      throw new Error(files.error || "목록 조회 실패");
    }

    if (!Array.isArray(files) || files.length === 0) {
      listStatus.textContent = "업로드된 파일이 없습니다.";
      return;
    }

    listStatus.textContent = `${files.length}개 파일`;

    for (const file of files) {
      const tr = document.createElement("tr");

      tr.innerHTML = `
        <td>${escapeHtml(file.originalName)}</td>
        <td>${escapeHtml(file.documentType)} / .${escapeHtml(file.extension)}</td>
        <td>${formatBytes(file.size)}</td>
        <td>${formatDate(file.updatedAt)}</td>
        <td>
          <div class="actions">
            <button class="link-btn" data-open="${file.id}">편집 열기</button>
            <a class="link-btn" href="${file.downloadUrl}" target="_blank" rel="noopener">다운로드</a>
          </div>
        </td>
      `;

      const openButton = tr.querySelector("button[data-open]");
      openButton.addEventListener("click", () => {
        window.location.href = `/editor.html?id=${encodeURIComponent(file.id)}`;
      });

      rows.appendChild(tr);
    }
  } catch (error) {
    listStatus.textContent = `오류: ${error.message}`;
  }
}

function formatBytes(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString("ko-KR", { hour12: false });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

void loadFiles();
