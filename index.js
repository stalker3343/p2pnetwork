const path = require("path");
const http = require("http");
const FormData = require("form-data");

const net = require("net");
const { createHash } = require("crypto");
const { Writable } = require("stream");
const fs = require("fs");
const axios = require("axios");
const { IncomingForm } = require("formidable");
const { exists, mkdir, rename, open, readdir, stat } = require("fs/promises");
const EventEmitter = require("events");
const splitStream = require("./split-stream");
let LOCAL_NETWORK_IP = "127.0.0.1";
let LOCAL_NETWORK_HTTP = "http://localhost";
let chunkCounter = 0;
const ROOT_PATH = path.join("storage");
let IS_FILE_FOUND = false;

function writeObjectToFile(object) {
  const jsonString = JSON.stringify(object, null, 2);

  fs.writeFile(path.join("dump.txt"), `${jsonString}`, (err) => {
    if (err) {
      console.error("Ошибка при записи файла:", err);
      return;
    }
    console.log("Файл успешно записан.");
  });
}

function randomInteger(min, max) {
  // случайное число от min до (max+1)
  let rand = min + Math.random() * (max + 1 - min);
  return Math.floor(rand);
}

function readObjectFromFile() {
  try {
    const fileContent = fs.readFileSync(
      path.join(process.cwd(), "dump.txt"),
      "utf8"
    );

    // Преобразуем строку JSON обратно в объект
    const object = JSON.parse(fileContent);

    return object;
  } catch (err) {
    console.error("Ошибка при чтении файла:", err);
    return null;
  }
}

let INDEX = readObjectFromFile() || {};

const CHUNK_SIZE = 20 * 1024; // 20KB

// 2: Создаем ноду P2P сети
const main = new EventEmitter();
const createNode = require("@swensson/p2p");

const node = createNode();
const PORT = Number(process.argv[2]);
const CURRENT_SERVER = `http://localhost:${PORT}`;
const CURRENT_FILE_SERVER = `http://localhost:${PORT + 1}`;

const INIT_NEIGHBORS = (process.argv[3] && process.argv[3].split("/")) || [];
const NEIGHBOR_ID_TO_IP = {};
setTimeout(() => node.listen(PORT, () => main.emit("startup", PORT)), 0);

// 2 собираем соседей
node.on("direct", ({ origin, message: { type } }) => {
  if (type === "ip") {
    node.direct(origin, { type: "ip/response", meta: { port: PORT } });
  }

  if (type === "get_neighbors") {
    const neighbors = Array.from(node.neighbors());
    node.direct(origin, { type: "neighbors/response", meta: neighbors });
  }
});

const getNeighbors = (id) =>
  new Promise((resolve) => {
    const listener = ({ origin, message: { type, meta } }) => {
      if (type === "neighbors/response" && id === origin) {
        resolve(meta);
        node.off("direct", listener);
      }
    };

    node.on("direct", listener);
    node.direct(id, { type: "get_neighbors", meta: {} });
  });

const getIp = (id) =>
  new Promise((resolve) => {
    const listener = ({ origin, message: { type, meta } }) => {
      if (type === "ip/response" && id === origin) {
        NEIGHBOR_ID_TO_IP[id] = meta.port;
        console.log("SUCCESS get of", id, meta);

        resolve(meta);
        node.off("direct", listener);
      }
    };

    node.on("direct", listener);
    console.log("START Get ip of", id);
    node.direct(id, { type: "ip", meta: {} });
  });

main.on("startup", async () => {
  console.log("EVENT startup");
  const initialConnection = (port) =>
    new Promise((resolve) => {
      const listener = () => {
        console.log(
          `Initial Connection to ${LOCAL_NETWORK_IP}:${port} established.`
        );
        resolve();
      };
      node.connect(LOCAL_NETWORK_IP, port, listener);
    });

  await Promise.all(INIT_NEIGHBORS.map((port) => initialConnection(port))).then(
    () => {
      const getNaighborsOfNeighbors = async () => {
        // console.log("FUNCTION getNaighborsOfNeighbors");

        const neighbors = Array.from(node.neighbors());
        const neighborsOfNeighborsGroups = await Promise.all(
          neighbors.map((id) => getNeighbors(id))
        );
        const neighborsOfNeighbors = neighborsOfNeighborsGroups.reduce(
          (acc, group) => acc.concat(group),
          []
        );
        const potentialConnections = neighborsOfNeighbors.filter(
          (id) => id !== node.id && !neighbors.includes(id)
        );
        const addressesToConnect = await Promise.all(
          potentialConnections.map((id) => getIp(id))
        );

        /*
      .slice(
        0,
        NEIGHBORS_COUNT_TARGET - neighbors.length
      )
      */
        for (let { port } of addressesToConnect) {
          node.connect(LOCAL_NETWORK_IP, port, () => {
            console.log(
              `🕷️ Connection to ${LOCAL_NETWORK_IP}:${port} established.`
            );
          });
        }

        // console.log("Node neighbors:", Array.from(node.neighbors()));
      };
      getNaighborsOfNeighbors();
      setInterval(getNaighborsOfNeighbors, 1000);
    }
  );
});

// работа с командами
main.on("startup", (port) => {
  console.log(`🕸️  Node is up on ${port}.`);

  // main.emit("help");

  process.stdin.on("data", (data) => main.emit("command", data.toString()));
});

async function uploadChunk(uploadUrl, chunk) {
  const form = new FormData();

  form.append("chunk", chunk, "test.pdf");
  form.append("offset", 1);

  try {
    const response = await axios.post(
      `${LOCAL_NETWORK_HTTP}:${uploadUrl + 1}/upload-chunk`,
      form,
      {
        headers: { "Content-Type": "multipart/form-data" },
      }
    );
    console.log(`Chunk uploaded successfully:`, response.data);
    return response.data;
  } catch (error) {
    console.error(`Error uploading chunk:`, error);
    process.exit(1);
  }
}

// Загрузка файлов в сеть
main.on("command", (text) => {
  if (text.startsWith("upload")) {
    const fileName = text.substr(7).trim();
    const uploadPath = path.join(fileName);

    const fileStream = fs.createReadStream(uploadPath, {
      highWaterMark: CHUNK_SIZE,
    });
    let chunkIndex = 0;
    const availableNodesId = Array.from(node.neighbors());

    fileStream.on("data", async (chunk) => {
      fileStream.pause(); // Приостанавливаем поток пока не загрузим текущий чанк
      const neiborToUpload =
        availableNodesId[randomInteger(0, availableNodesId.length - 1)];
      let uploadUrl =
        NEIGHBOR_ID_TO_IP[neiborToUpload] || (await getIp(neiborToUpload));

      if (uploadUrl.port) {
        uploadUrl = uploadUrl.port;
      }

      console.log("CHANK UPLOAD TO", uploadUrl);

      const { getChunkUrl } = await uploadChunk(uploadUrl, chunk);
      if (!INDEX[fileName]) INDEX[fileName] = [];
      INDEX[fileName].push({
        offset: chunkIndex,
        getChunkUrl,
      });
      writeObjectToFile(INDEX);
      // , chunkIndex, filePath
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
});

const server = http.createServer((req, res) => {
  console.log(req.method, req.url);
  if (req.method === "POST" && req.url === "/upload-chunk") {
    const form = new IncomingForm();

    form.parse(req, (err, fields, files) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Server Error");
        return;
      }

      const chunkFile = files.chunk;
      if (!chunkFile) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("No chunk file uploaded");
        return;
      }
      const newChunkName = `chunk_${chunkCounter}.bin`;
      const newPath = path.join(ROOT_PATH, newChunkName);

      const readStream = fs.createReadStream(chunkFile[0].filepath);
      const writeStream = fs.createWriteStream(newPath);

      readStream.pipe(writeStream);

      writeStream.on("finish", async () => {
        console.log(`Chunk saved to ${newPath}`);
        chunkCounter++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            getChunkUrl: `${CURRENT_FILE_SERVER}/download-chunk?id=${newChunkName}`,
          })
        );
      });

      writeStream.on("error", (err) => {
        console.error("File write error:", err);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("File write error");
      });
    });
  } else if (req.method === "GET" && req.url.startsWith("/download-chunk")) {
    const urlParams = new URLSearchParams(req.url.split("?")[1]);
    const chunkName = urlParams.get("id");

    console.log("start", chunkName, req.url);

    const chunkPath = path.join(ROOT_PATH, chunkName);

    if (fs.existsSync(chunkPath)) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      fs.createReadStream(chunkPath).pipe(res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Chunk not found");
    }
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

server.listen(PORT + 1, () => {
  console.log(`File server of node ${PORT} is listening on port ${PORT + 1}`);
});

server.on("error", (err) => {
  console.error("Server error:", err);
});

// Поиск файлов
main.on("command", (text) => {
  if (text.startsWith("search")) {
    const searchRequest = text.substr(7).trim();

    console.log(`🔎 Searching for file by "${searchRequest}"...`);
    node.broadcast({ type: "search", meta: searchRequest });

    setTimeout(() => {
      if (!IS_FILE_FOUND) {
        console.log("FILE NOT FOUND");
      } else {
        IS_FILE_FOUND = false;
      }
    }, 5000);
  }
});

node.on("broadcast", ({ origin, message: { type, meta } }) => {
  if (type === "search" && origin !== node.id) {
    console.log("Пришли проверить файл", meta);
    if (INDEX[meta]) {
      node.direct(origin, { type: "search/response", meta: INDEX[meta] });
    }
    // for (let key of INDEX.keys()) {
    //   const data = INDEX.get(key);

    //   if (data.name.toLowerCase().includes(meta.toLowerCase())) {
    //     node.direct(origin, { type: "search/response", meta: data });
    //   }
    // }
  }
});

// куда сохранять файлы
const DOWNLOADS_PATH = path.resolve(process.cwd(), ".downloads");

(async () => {
  if (!(await stat(DOWNLOADS_PATH).catch(() => null))) {
    await mkdir(DOWNLOADS_PATH, 0744);
  }
})();
// Поиск файла
node.on("direct", ({ origin, message: { type, meta } }) => {
  if (type === "search/response") {
    IS_FILE_FOUND = true;
    console.log(`FILES FOUND on ${origin} WITH ${meta.length} CHANKS`);
  }
});

// скачаивание файла
main.on("command", (text) => {
  if (text.startsWith("download")) {
    main.emit("download", text.substr(9).trim());
  }
});

main.on("download", (filename) => {
  node.broadcast({ type: "download", meta: filename });
});

node.on("broadcast", ({ origin, message: { type, meta } }) => {
  if (type === "download" && origin !== node.id) {
    const data = INDEX[meta];

    if (!!data) {
      node.direct(origin, {
        type: "download/response",
        meta: data,
      });
    }
  }
});

async function downloadChunk(chunkUrl, outputStream) {
  try {
    const response = await axios.get(chunkUrl, { responseType: "stream" });
    response.data.pipe(outputStream, { end: false });
    await new Promise((resolve) => response.data.on("end", resolve));
    console.log(`Chunk ${chunkUrl} downloaded successfully`);
  } catch (error) {
    console.error(`Error downloading chunk ${chunkUrl}:`, error);
    process.exit(1);
  }
}

async function downloadChunksAndMerge(chunks) {
  const OUTPUT_FILE = "output.bin";

  const outputStream = fs.createWriteStream(OUTPUT_FILE);

  for (const chunkUrl of chunks) {
    await downloadChunk(chunkUrl.getChunkUrl, outputStream);
  }

  outputStream.end();
  console.log("All chunks have been downloaded and merged into", OUTPUT_FILE);
}

node.on("direct", ({ origin, message: { type, meta } }) => {
  if (type === "download/response") {
    console.log("Downloading");
    downloadChunksAndMerge(meta);
  }
});
