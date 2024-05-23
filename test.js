const path = require("path");
const { createReadStream } = require("fs");
async function uploadFileInChunks(filePath) {
  const fileStream = fs.createReadStream(filePath, {
    highWaterMark: CHUNK_SIZE,
  });
  let chunkIndex = 0;

  fileStream.on("data", async (chunk) => {
    fileStream.pause(); // Приостанавливаем поток пока не загрузим текущий чанк
    const uploadUrl = "";
    await uploadChunk(uploadUrl, chunk, chunkIndex, filePath);
    chunkIndex++;
    fileStream.resume(); // Возобновляем поток для следующего чанка
  });

  fileStream.on("end", () => {
    console.log("File transmission complete");
  });

  fileStream.on("error", (err) => {
    console.error("Error reading file:", err);
  });
}

function uploadChunk(uploadUrl, chunk, chunkIndex, filePath) {
  console.log(
    "🚀 ~ uploadChunk ~ uploadUrl, chunk, chunkIndex, filePath:",
    uploadUrl,
    chunk,
    chunkIndex,
    filePath
  );
  const form = new FormData();
  form.append("chunk", chunk, filePath);
  form.append("offset", chunkIndex);

  try {
    // const response = await axios.post(`${uploadUrl}`, form, {
    //   headers: form.getHeaders(),
    // });
    console.log(`Chunk ${chunkIndex} uploaded successfully:`, response.data);
  } catch (error) {
    console.error(`Error uploading chunk ${chunkIndex}:`, error);
    process.exit(1);
  }
}

uploadFileInChunks("test.pdf");
