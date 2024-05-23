const path = require("path");
const net = require("net");
const { createHash } = require("crypto");
const { Writable } = require("stream");
const { createReadStream } = require("fs");
const { exists, mkdir, rename, open, readdir, stat } = require("fs/promises");
const EventEmitter = require("events");
const splitStream = require("./split-stream");

// Хелперы
const hashFile = (filepath) =>
  new Promise((resolve) => {
    createReadStream(filepath)
      .pipe(createHash("sha256"))
      .setEncoding("hex")
      .pipe(
        new Writable({
          write(chunk, enc, next) {
            resolve(chunk.toString());
          },
        })
      );
  });

const formatSize = (size) => {
  const suffixes = ["B", "KB", "MB", "GB", "TB", "PB"];
  let suffixIndex = 0;

  while (size >= 1024) {
    size = size / 1024;
    suffixIndex++;
  }

  return `${size.toFixed(2)}${suffixes[suffixIndex]}`;
};

// Индексация фалов в папке
const index = new Map();

async function* findFiles(folder) {
  for (let filename of await readdir(folder)) {
    const filepath = path.resolve(folder, filename);
    const filestats = await stat(filepath);

    if (filestats.isDirectory()) {
      yield* findFiles(filepath);
    } else {
      yield { path: filepath, size: filestats.size };
    }
  }
}

const indexFiles = async () => {
  console.log("🌱 Indexing files...");

  for await (let { path, size } of findFiles(process.cwd())) {
    const [name] = path.split("/").slice(-1);
    const hash = await hashFile(path);

    index.set(hash, { hash, size, name, path });
  }

  console.log(`🌳 Directory content indexed, ${index.size} files found.`);
};

indexFiles();

setInterval(() => indexFiles(), 60000);

// 2: Создаем ноду P2P сети
const main = new EventEmitter();
const createNode = require("@swensson/p2p");

const node = createNode();
const PORT = Number(process.argv[2]);

setTimeout(() => node.listen(PORT, () => main.emit("startup", PORT)), 0);

// 2 собираем соседей
const NEIGHBORS_COUNT_TARGET = 5;
let ip = "127.0.0.1";

require("https").get("https://api.ipify.org?format=text", (responseStream) => {
  let data = "";
  responseStream
    .on("data", (chunk) => (data += chunk))
    .on("end", () => {
      ip = data;
    });
});

const getNeighbors = (id) =>
  new Promise((resolve) => {
    const listener = ({ origin, message: { type, meta } }) => {
      if (type === "balance/response" && id === origin) {
        resolve(meta);
        node.off("direct", listener);
      }
    };

    node.on("direct", listener);
    node.direct(id, { type: "balance", meta: {} });
  });

const getIp = (id) =>
  new Promise((resolve) => {
    const listener = ({ origin, message: { type, meta } }) => {
      if (type === "ip/response" && id === origin) {
        resolve(meta);
        node.off("direct", listener);
      }
    };

    node.on("direct", listener);
    node.direct(id, { type: "ip", meta: {} });
  });

node.on("direct", ({ origin, message: { type } }) => {
  if (type === "ip") {
    node.direct(origin, { type: "ip/response", meta: { ip, PORT } });
  }
});

node.on("direct", ({ origin, message: { type } }) => {
  if (type === "balance") {
    const neighbors = Array.from(node.neighbors());

    node.direct(origin, { type: "balance/response", meta: neighbors });
  }
});

main.on("startup", () => {
  setInterval(async () => {
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

    for (let { ip, port } of addressesToConnect.slice(
      0,
      NEIGHBORS_COUNT_TARGET - neighbors.length
    )) {
      node.connect(ip, port, () => {
        console.log(
          `🕷️ Connection to ${ip} established (network random rebalance).`
        );
      });
    }
  }, 30000);
});

// 3: Информация о командах доступных
main.on("startup", (port) => {
  console.log(`🕸️  Node is up on ${port}.`);

  main.emit("help");

  process.stdin.on("data", (data) => main.emit("command", data.toString()));
});

// 4: Подключение по ip
main.on("help", () => {
  console.log(
    '    - write "connect IP:PORT" to connect to other nodes on network.'
  );
});

main.on("command", (text) => {
  if (text.startsWith("connect")) {
    const ipport = text.substr(8);
    const [ip, port] = ipport.split(":");

    console.log(`🕷️ Connecting to ${ip} at ${Number(port)}...`);
    node.connect(ip, Number(port), () => {
      console.log(`🕷️ Connection to ${ip} established.`);
    });
  }
});

// 5 Поиск файлов
main.on("help", () => {
  console.log('    - write "search FILENAME" to look for files.');
});

main.on("command", (text) => {
  if (text.startsWith("search")) {
    const searchRequest = text.substr(7).trim();

    console.log(`🔎 Searching for file by "${searchRequest}"...`);
    node.broadcast({ type: "search", meta: searchRequest });
  }
});

node.on("broadcast", ({ origin, message: { type, meta } }) => {
  if (type === "search" && origin !== node.id) {
    for (let key of index.keys()) {
      const data = index.get(key);

      if (data.name.toLowerCase().includes(meta.toLowerCase())) {
        node.direct(origin, { type: "search/response", meta: data });
      }
    }
  }
});

node.on("direct", ({ origin, message: { type, meta } }) => {
  if (type === "search/response") {
    const { name, size, hash } = meta;

    console.log(`  ${name} ${formatSize(size)} ${hash}`);
  }
});

// 6: скачивание фалов после поиска
main.on("help", () => {
  console.log('    - write "download HASH" to start downloading file');
});

main.on("command", (text) => {
  if (text.startsWith("download")) {
    main.emit("download", text.substr(9).trim());
  }
});

// получение мета ифнормации
const downloads = {};

main.on("download", (hash) => {
  console.log(`🔎 Looking for "${hash}" metadata...`);
  node.broadcast({ type: "download", meta: hash });
});

node.on("broadcast", ({ origin, message: { type, meta } }) => {
  if (type === "download" && origin !== node.id) {
    const data = index.get(meta);

    if (!!data) {
      node.direct(origin, {
        type: "download/response",
        meta: { ip: ip, hash: data.hash, size: data.size, name: data.name },
      });
    }
  }
});

node.on("direct", ({ origin, message: { type, meta } }) => {
  if (type === "download/response") {
    if (!downloads[meta.hash]) {
      downloads[meta.hash] = {
        hash: meta.hash,
        name: meta.name,
        size: meta.size,
        seeds: [meta.ip],
        chunks: [],
      };

      main.emit("download/ready", meta.hash);
    } else {
      downloads[meta.hash].seeds.push(meta.ip);
      main.emit("download/update", meta.hash);
    }
  }
});

//  7: сервер для ответа файлами
const FILES_SERVER_PORT = 30163;
const CHUNK_SIZE = 512;

const filesServer = net
  .createServer((socket) => {
    socket.pipe(splitStream()).on("data", async ({ hash, offset }) => {
      const data = index.get(hash);

      const chunk = Buffer.alloc(CHUNK_SIZE);
      const file = await open(data.path, "r");

      await file.read(chunk, 0, CHUNK_SIZE, offset * CHUNK_SIZE);
      await file.close();

      socket.write(JSON.stringify({ hash, offset, chunk }));
    });
  })
  .listen(FILES_SERVER_PORT);

const downloadChunk = (socket, hash, offset) =>
  new Promise((resolve) => {
    const socketSplitStream = socket.pipe(splitStream());

    socket.write(JSON.stringify({ hash, offset }));

    const listener = (message) => {
      if (hash === message.hash && offset === message.offset) {
        socketSplitStream.off("data", listener);
        resolve(message.chunk);
      }
    };

    socketSplitStream.on("data", listener);
  });

//  8: само скачаиние файлов. Чаник создаются на основе размера разделенного на кол-во файлов
const DOWNLOADS_PATH = path.resolve(process.cwd(), ".downloads");

(async () => {
  if (!(await stat(DOWNLOADS_PATH).catch(() => null))) {
    await mkdir(DOWNLOADS_PATH, 0744);
  }
})();

main.on("download/ready", async (hash) => {
  console.log("Downloading", hash);
  downloads[hash].path = path.resolve(DOWNLOADS_PATH, `${hash}.download`);
  downloads[hash].chunks = [
    ...new Array(Math.ceil(downloads[hash].size / CHUNK_SIZE)),
  ].map(() => ({ state: 0 }));

  const file = await open(downloads[hash].path, "w");

  // подключение

  const sockets = {};

  const updateSocketsList = async ($hash) => {
    if ($hash === hash) {
      for (let ip of downloads[hash].seeds) {
        if (!sockets[ip]) {
          const socket = new net.Socket();

          socket.connect(FILES_SERVER_PORT, ip, () => {
            sockets[ip] = { socket, busy: false };
          });
        }
      }
    }
  };

  updateSocketsList(hash);

  main.on("download/update", updateSocketsList);

  while (!!downloads[hash].chunks.find((chunk) => chunk.state !== 2)) {
    const availableChunkIndex = downloads[hash].chunks.findIndex(
      (chunk) => chunk.state === 0
    );
    const availableSocket = Object.values(sockets).find(({ busy }) => !busy);

    if (!availableSocket || availableChunkIndex === -1) {
      await new Promise((resolve) => setTimeout(() => resolve(), 50));
      continue;
    }

    availableSocket.busy = true;
    downloads[hash].chunks[availableChunkIndex].state = 1;

    (async () => {
      const chunk = await downloadChunk(
        availableSocket.socket,
        hash,
        availableChunkIndex
      );

      await file.write(
        Buffer.from(chunk),
        0,
        CHUNK_SIZE,
        availableChunkIndex * CHUNK_SIZE
      );

      downloads[hash].chunks[availableChunkIndex].state = 2;
      availableSocket.busy = false;
    })();
  }

  await file.close();
  await rename(
    downloads[hash].path,
    path.resolve(DOWNLOADS_PATH, downloads[hash].name)
  );

  main.off("download/update", updateSocketsList);

  for (let { socket } of Object.values(sockets)) {
    socket.destroy();
  }

  console.log("Download completed", hash);
});
