import fs from "fs";
import net from "net";
import path from "path";

const writeInt16 = (value) => {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16BE(value, 0);
  return buffer;
};

const writeInt32 = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value, 0);
  return buffer;
};

const writeUnsignedVarint = (value) => {
  const bytes = [];
  let remaining = value;

  while (true) {
    const byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining === 0) {
      bytes.push(byte);
      break;
    }
    bytes.push(byte | 0x80);
  }

  return Buffer.from(bytes);
};

const writeCompactString = (value) => {
  if (value === null) {
    return writeUnsignedVarint(0);
  }

  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([writeUnsignedVarint(bytes.length + 1), bytes]);
};

const writeBool = (value) => Buffer.from([value ? 1 : 0]);
const writeInt8 = (value) => Buffer.from([value]);

const writeUuid = (value) => Buffer.from(value.replace(/-/g, ""), "hex");

const readUnsignedVarint = (buffer, offset) => {
  let value = 0;
  let shift = 0;
  let position = offset;

  while (position < buffer.length) {
    const byte = buffer[position];
    value |= (byte & 0x7f) << shift;
    position += 1;

    if ((byte & 0x80) === 0) {
      return { value, bytesRead: position - offset };
    }

    shift += 7;
  }

  return { value, bytesRead: 0 };
};

const readCompactString = (buffer, offset) => {
  const { value: length, bytesRead } = readUnsignedVarint(buffer, offset);
  if (length === 0) {
    return { value: null, offset: offset + bytesRead };
  }

  if (length === 1) {
    return { value: "", offset: offset + bytesRead };
  }

  const stringLength = length - 1;
  const start = offset + bytesRead;
  const end = start + stringLength;
  return { value: buffer.subarray(start, end).toString("utf8"), offset: end };
};

const decodeBase64Uuid = (value) => {
  if (!value) {
    return null;
  }

  const bytes = Buffer.from(value.trim(), "base64");
  if (bytes.length !== 16) {
    return null;
  }

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
};

const getLogDirectories = () => {
  const configPath = process.argv[2] || "/tmp/server.properties";
  const fallback = ["/tmp/kraft-combined-logs", "/tmp/kraft-generated-logs"];

  if (!fs.existsSync(configPath)) {
    return fallback.filter((dir) => fs.existsSync(dir));
  }

  const config = fs.readFileSync(configPath, "utf8");
  const logDirsLine = config
    .split(/\r?\n/)
    .find((line) => line.trim().startsWith("log.dirs="));

  if (!logDirsLine) {
    return fallback.filter((dir) => fs.existsSync(dir));
  }

  const rawValue = logDirsLine.split("=")[1].trim();
  const dirs = rawValue.split(",").map((entry) => entry.trim()).filter(Boolean);
  return dirs.length > 0 ? dirs : fallback.filter((dir) => fs.existsSync(dir));
};

const getTopicUuid = (topicName) => {
  if (!topicName) {
    return null;
  }

  for (const logDir of getLogDirectories()) {
    if (!fs.existsSync(logDir)) {
      continue;
    }

    const entries = fs.readdirSync(logDir, { withFileTypes: true });
    const topicDir = entries.find((entry) => entry.isDirectory() && entry.name.startsWith(`${topicName}-`));
    if (!topicDir) {
      continue;
    }

    const metadataPath = path.join(logDir, topicDir.name, "partition.metadata");
    if (!fs.existsSync(metadataPath)) {
      continue;
    }

    const metadata = fs.readFileSync(metadataPath, "utf8");
    const line = metadata
      .split(/\r?\n/)
      .find((entry) => entry.startsWith("topic_id:"));

    if (!line) {
      continue;
    }

    const value = line.slice("topic_id:".length).trim();
    const uuid = decodeBase64Uuid(value);
    if (uuid) {
      return uuid;
    }
  }

  return null;
};

const getTopicPartitions = (topicName) => {
  if (!topicName) {
    return [];
  }

  const partitions = [];
  for (const logDir of getLogDirectories()) {
    if (!fs.existsSync(logDir)) {
      continue;
    }

    const entries = fs.readdirSync(logDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(`${topicName}-`)) {
        continue;
      }

      const match = entry.name.match(/-(\d+)$/);
      if (!match) {
        continue;
      }

      partitions.push(Number.parseInt(match[1], 10));
    }
  }

  return partitions.sort((a, b) => a - b);
};

const encodePartition = (partitionIndex) => Buffer.concat([
  writeInt16(0),
  writeInt32(partitionIndex),
  writeInt32(1),
  writeInt32(0),
  writeUnsignedVarint(2),
  writeInt32(1),
  writeUnsignedVarint(2),
  writeInt32(1),
  writeUnsignedVarint(1),
  writeUnsignedVarint(1),
  writeUnsignedVarint(1),
  writeUnsignedVarint(0),
]);

const parseDescribeTopicPartitionsRequest = (request, offset) => {
  const topicNames = [];

  if (offset >= request.length) {
    return { topicNames, offset };
  }

  const { value: topicsArrayLength, bytesRead } = readUnsignedVarint(request, offset);
  offset += bytesRead;

  if (topicsArrayLength > 0) {
    const topicCount = topicsArrayLength === 1 ? 0 : topicsArrayLength - 1;
    for (let i = 0; i < topicCount; i += 1) {
      const { value: topicName, offset: nextOffset } = readCompactString(request, offset);
      topicNames.push(topicName ?? "");
      offset = nextOffset;

      if (offset < request.length) {
        const { value: tag, bytesRead: tagBytes } = readUnsignedVarint(request, offset);
        if (tag === 0) {
          offset += tagBytes;
        }
      }
    }
  }

  if (offset + 4 <= request.length) {
    offset += 4;
  }

  if (offset < request.length) {
    offset += 1;
  }

  if (offset < request.length) {
    const { value: tag, bytesRead: tagBytes } = readUnsignedVarint(request, offset);
    if (tag === 0) {
      offset += tagBytes;
    }
  }

  return { topicNames, offset };
};

const server = net.createServer((connection) => {
  let buffer = Buffer.alloc(0);

  connection.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
      const messageSize = buffer.readInt32BE(0);
      if (buffer.length < 4 + messageSize) {
        break;
      }

      const request = buffer.subarray(0, 4 + messageSize);
      buffer = buffer.subarray(4 + messageSize);

      const requestApiKey = request.readInt16BE(4);
      const requestApiVersion = request.readInt16BE(6);
      const correlationId = request.readInt32BE(8);

      let offset = 12;
      if (offset + 2 <= request.length) {
        const clientIdLength = request.readInt16BE(offset);
        offset += 2;
        offset += clientIdLength;
      }

      if (offset < request.length) {
        const { value: tag, bytesRead } = readUnsignedVarint(request, offset);
        if (tag === 0) {
          offset += bytesRead;
        }
      }

      let responseBody;

      if (requestApiKey === 1) {
        responseBody = Buffer.concat([
          writeInt32(0),
          writeInt16(0),
          writeInt32(0),
          writeUnsignedVarint(1),
          writeUnsignedVarint(0),
        ]);
      } else if (requestApiKey === 18) {
        console.error("API_VERSIONS_REQUEST", { requestApiVersion, requestLength: request.length, requestHex: request.toString("hex") });

        const errorCode = requestApiVersion >= 0 && requestApiVersion <= 4 ? 0 : 35;
        const apiKeys = [
          [1, 0, 16],
          [18, 0, 4],
          [75, 0, 0],
        ];

        const apiKeysArrayLengthBuffer = writeUnsignedVarint(apiKeys.length + 1);
        const apiKeyEntries = Buffer.concat(
          apiKeys.map(([apiKey, minVersion, maxVersion]) => Buffer.concat([
            writeInt16(apiKey),
            writeInt16(minVersion),
            writeInt16(maxVersion),
            writeUnsignedVarint(0),
          ])),
        );

        const responseParts = [
          writeInt16(errorCode),
          apiKeysArrayLengthBuffer,
          apiKeyEntries,
        ];

        if (requestApiVersion >= 1) {
          responseParts.push(writeInt32(0));
        }

        if (requestApiVersion >= 3) {
          responseParts.push(writeUnsignedVarint(0));
        }

        responseBody = Buffer.concat(responseParts);
      } else if (requestApiKey === 75) {
        const { topicNames } = parseDescribeTopicPartitionsRequest(request, offset);
        const requestedTopics = [...topicNames].filter(Boolean).sort((left, right) => left.localeCompare(right));

        const topicResponses = requestedTopics.map((topicName) => {
          const topicUuidValue = getTopicUuid(topicName);
          const topicUuid = topicUuidValue ? writeUuid(topicUuidValue) : Buffer.alloc(16);
          const topicErrorCode = topicUuidValue ? 0 : 3;
          const partitions = getTopicPartitions(topicName);

          const partitionResponses = partitions.map((partitionIndex) => Buffer.concat([
            writeInt16(0),
            writeInt32(partitionIndex),
            writeInt32(1),
            writeInt32(0),
            writeUnsignedVarint(2),
            writeInt32(1),
            writeUnsignedVarint(2),
            writeInt32(1),
            writeUnsignedVarint(1),
            writeUnsignedVarint(1),
            writeUnsignedVarint(1),
            writeUnsignedVarint(0),
          ]));

          return Buffer.concat([
            writeInt16(topicErrorCode),
            writeCompactString(topicName),
            topicUuid,
            writeBool(false),
            writeUnsignedVarint(partitions.length === 0 ? 1 : partitions.length + 1),
            ...partitionResponses,
            writeInt32(0),
            writeUnsignedVarint(0),
          ]);
        });

        responseBody = Buffer.concat([
          writeInt32(0),
          writeUnsignedVarint(requestedTopics.length === 0 ? 1 : requestedTopics.length + 1),
          ...topicResponses,
          writeInt8(-1),
          writeUnsignedVarint(0),
        ]);
      } else {
        responseBody = Buffer.alloc(0);
      }

      const responseHeader = [1, 75].includes(requestApiKey)
        ? Buffer.concat([writeInt32(correlationId), writeUnsignedVarint(0)])
        : writeInt32(correlationId);

      const response = Buffer.alloc(4 + responseHeader.length + responseBody.length);
      response.writeInt32BE(responseHeader.length + responseBody.length, 0);
      responseHeader.copy(response, 4);
      responseBody.copy(response, 4 + responseHeader.length);

      connection.write(response);
    }
  });
});

server.listen(9092, "127.0.0.1");
