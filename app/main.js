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
const writeInt64 = (value) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(BigInt(value), 0);
  return buffer;
};

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

const getKnownTopicUuids = () => {
  const knownUuids = new Set();

  for (const logDir of getLogDirectories()) {
    if (!fs.existsSync(logDir)) {
      continue;
    }

    for (const entry of fs.readdirSync(logDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const metadataPath = path.join(logDir, entry.name, "partition.metadata");
      if (!fs.existsSync(metadataPath)) {
        continue;
      }

      const metadata = fs.readFileSync(metadataPath, "utf8");
      for (const line of metadata.split(/\r?\n/)) {
        if (!line.startsWith("topic_id:")) {
          continue;
        }

        const uuid = decodeBase64Uuid(line.slice("topic_id:".length).trim());
        if (uuid) {
          knownUuids.add(uuid);
        }
      }
    }
  }

  return knownUuids;
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

const getTopicLogPathByUuid = (topicUuid, partitionIndex) => {
  if (!topicUuid) {
    return null;
  }

  for (const logDir of getLogDirectories()) {
    if (!fs.existsSync(logDir)) {
      continue;
    }

    const entries = fs.readdirSync(logDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const metadataPath = path.join(logDir, entry.name, "partition.metadata");
      if (!fs.existsSync(metadataPath)) {
        continue;
      }

      const metadata = fs.readFileSync(metadataPath, "utf8");
      const line = metadata
        .split(/\r?\n/)
        .find((entryLine) => entryLine.startsWith("topic_id:"));

      if (!line) {
        continue;
      }

      const uuid = decodeBase64Uuid(line.slice("topic_id:".length).trim());
      if (uuid !== topicUuid) {
        continue;
      }

      const topicDir = path.join(logDir, entry.name);
      const candidateFiles = fs.readdirSync(topicDir)
        .filter((fileName) => fileName.endsWith(".log"))
        .sort();

      const desiredName = `${String(partitionIndex).padStart(20, "0")}.log`;
      const exactMatch = candidateFiles.find((fileName) => fileName === desiredName)
        || candidateFiles.find((fileName) => fileName.replace(/\.log$/, "") === String(partitionIndex))
        || candidateFiles.find((fileName) => fileName.replace(/\.log$/, "").endsWith(String(partitionIndex)))
        || candidateFiles[0];

      if (exactMatch) {
        return path.join(topicDir, exactMatch);
      }
    }
  }

  return null;
};

const readRecordBatchBytesForPartition = (topicUuid, partitionIndex) => {
  const logPath = getTopicLogPathByUuid(topicUuid, partitionIndex);
  if (!logPath || !fs.existsSync(logPath)) {
    return Buffer.alloc(0);
  }

  return fs.readFileSync(logPath);
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

const readUuid = (buffer, offset) => {
  if (offset + 16 > buffer.length) {
    return { value: null, offset };
  }

  const raw = buffer.subarray(offset, offset + 16);
  const hex = raw.toString("hex");
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");

  return { value: uuid, offset: offset + 16 };
};

const writeString = (value) => {
  const bytes = Buffer.from(value ?? "", "utf8");
  return Buffer.concat([writeInt16(bytes.length), bytes]);
};

const readString = (buffer, offset) => {
  if (offset + 2 > buffer.length) {
    return { value: "", offset };
  }

  const length = buffer.readInt16BE(offset);
  const start = offset + 2;
  const end = start + length;

  return {
    value: buffer.toString("utf8", start, end),
    offset: end,
  };
};

const skipCompactArrayOfInt32 = (buffer, offset) => {
  const { value: length, bytesRead } = readUnsignedVarint(buffer, offset);
  const count = length === 0 ? 0 : length - 1;
  return offset + bytesRead + count * 4;
};

const parseClusterMetadataPayload = (payload) => {
  if (payload.length < 3) {
    return null;
  }

  const frameVersion = payload[0];
  const type = payload[1];
  const version = payload[2];
  const rest = payload.subarray(3);
  let cursor = 0;

  if (type === 2) {
    const { value: nameLength, bytesRead: nameLengthBytes } = readUnsignedVarint(rest, cursor);
    cursor += nameLengthBytes;
    const topicName = rest.subarray(cursor, cursor + nameLength - 1).toString("utf8");
    cursor += nameLength - 1;
    const { value: topicUuid, offset: uuidOffset } = readUuid(rest, cursor);
    cursor = uuidOffset;
    return {
      type: "topic",
      frameVersion,
      version,
      name: topicName,
      uuid: topicUuid,
      cursor,
    };
  }

  if (type === 3) {
    const partitionId = rest.readInt32BE(cursor);
    cursor += 4;
    const { value: topicUuid, offset: topicUuidOffset } = readUuid(rest, cursor);
    cursor = topicUuidOffset;
    cursor = skipCompactArrayOfInt32(rest, cursor);
    cursor = skipCompactArrayOfInt32(rest, cursor);
    cursor = skipCompactArrayOfInt32(rest, cursor);
    cursor = skipCompactArrayOfInt32(rest, cursor);
    const leader = rest.readInt32BE(cursor);
    cursor += 4;
    const leaderEpoch = rest.readInt32BE(cursor);
    cursor += 4;
    const partitionEpoch = rest.readInt32BE(cursor);
    cursor += 4;

    const { value: directoryUuidCount, bytesRead: directoryUuidCountBytes } = readUnsignedVarint(rest, cursor);
    cursor += directoryUuidCountBytes;
    const directoryUuidCountValue = directoryUuidCount === 0 ? 0 : directoryUuidCount - 1;
    const directoryUuids = [];
    for (let i = 0; i < directoryUuidCountValue; i += 1) {
      const { value: directoryUuid } = readUuid(rest, cursor);
      if (directoryUuid) {
        directoryUuids.push(directoryUuid);
      }
      cursor += 16;
    }

    return {
      type: "partition",
      frameVersion,
      version,
      partitionId,
      topicUuid,
      leader,
      leaderEpoch,
      partitionEpoch,
      directoryUuids,
      cursor,
    };
  }

  return null;
};

const parseClusterMetadataLogFile = (logPath) => {
  if (!logPath || !fs.existsSync(logPath)) {
    return { topicRecords: [], partitionRecords: [] };
  }

  const buffer = fs.readFileSync(logPath);
  const topicRecords = [];
  const partitionRecords = [];
  let offset = 0;

  while (offset + 21 <= buffer.length) {
    const batchStart = offset;
    offset += 8;
    const batchLength = buffer.readInt32BE(offset);
    offset += 4;
    offset += 4;
    offset += 1;
    offset += 4;

    const attributes = buffer.readInt16BE(offset);
    offset += 2;
    offset += 4;
    offset += 8;
    offset += 8;
    offset += 8;
    offset += 2;
    offset += 4;
    const recordsCount = buffer.readInt32BE(offset);
    offset += 4;

    for (let i = 0; i < recordsCount; i += 1) {
      const { value: recordSize, bytesRead: recordSizeBytes } = readUnsignedVarint(buffer, offset);
      offset += recordSizeBytes;
      const recordEnd = offset + Number(recordSize);

      offset += 1;
      const { bytesRead: timestampDeltaBytes } = readUnsignedVarint(buffer, offset);
      offset += timestampDeltaBytes;
      const { bytesRead: offsetDeltaBytes } = readUnsignedVarint(buffer, offset);
      offset += offsetDeltaBytes;

      const { value: keyLength, bytesRead: keyLengthBytes } = readUnsignedVarint(buffer, offset);
      offset += keyLengthBytes;
      if (keyLength > 0) {
        offset += keyLength;
      }

      const { value: valueLength, bytesRead: valueLengthBytes } = readUnsignedVarint(buffer, offset);
      offset += valueLengthBytes;
      if (valueLength > 0) {
        const payload = buffer.subarray(offset, offset + valueLength);
        const record = parseClusterMetadataPayload(payload);
        if (record && record.type === "topic") {
          topicRecords.push(record);
        } else if (record && record.type === "partition") {
          partitionRecords.push(record);
        }
        offset += valueLength;
      }

      const { value: headersLength, bytesRead: headersLengthBytes } = readUnsignedVarint(buffer, offset);
      offset += headersLengthBytes;
      if (headersLength > 0) {
        for (let j = 0; j < headersLength; j += 1) {
          const { value: headerKeyLength, bytesRead: headerKeyLengthBytes } = readUnsignedVarint(buffer, offset);
          offset += headerKeyLengthBytes;
          if (headerKeyLength > 0) {
            offset += headerKeyLength;
          }
          const { value: headerValueLength, bytesRead: headerValueLengthBytes } = readUnsignedVarint(buffer, offset);
          offset += headerValueLengthBytes;
          if (headerValueLength > 0) {
            offset += headerValueLength;
          }
        }
      }

      offset = recordEnd;
    }

    offset = batchStart + 8 + 4 + batchLength;
  }

  return { topicRecords, partitionRecords };
};

const getValidIotProduceResponse = (topicName, partitionIndex) => {
  const topicUuid = getTopicUuid(topicName);
  if (!topicUuid) {
    return null;
  }

  const partitions = getTopicPartitions(topicName);
  if (!partitions.includes(partitionIndex)) {
    return null;
  }

  return {
    topicName,
    partitionIndex,
    errorCode: 0,
    baseOffset: 0,
    logAppendTimeMs: -1,
    logStartOffset: 0,
  };
};

const appendProduceRecordBatchToDisk = (topicName, partitionIndex, recordBatchBytes) => {
  if (!recordBatchBytes || recordBatchBytes.length === 0) {
    return null;
  }

  for (const logDir of getLogDirectories()) {
    const topicDir = path.join(logDir, `${topicName}-${partitionIndex}`);
    fs.mkdirSync(topicDir, { recursive: true });
    const logPath = path.join(topicDir, "00000000000000000000.log");
    const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath) : Buffer.alloc(0);
    fs.writeFileSync(logPath, Buffer.concat([existing, recordBatchBytes]));
    return logPath;
  }

  return null;
};

const parseProduceRequest = (request, offset) => {
  let cursor = offset;

  const { value: transactionalId, offset: afterTransactionalId } = readCompactString(request, cursor);
  cursor = afterTransactionalId;

  const acks = request.readInt16BE(cursor);
  cursor += 2;

  cursor += 4;

  const { value: topicsArrayLength, bytesRead: topicsArrayBytesRead } = readUnsignedVarint(request, cursor);
  cursor += topicsArrayBytesRead;

  const topicCount = topicsArrayLength === 0 ? 0 : topicsArrayLength - 1;
  let topicName = "";
  let partitionIndex = -1;
  let recordBatchBytes = Buffer.alloc(0);

  for (let i = 0; i < topicCount; i += 1) {
    const { value: currentTopicName, offset: afterTopicName } = readCompactString(request, cursor);
    cursor = afterTopicName;
    topicName = currentTopicName ?? "";

    const { value: partitionsArrayLength, bytesRead: partitionsArrayBytesRead } = readUnsignedVarint(request, cursor);
    cursor += partitionsArrayBytesRead;

    const partitionCount = partitionsArrayLength === 0 ? 0 : partitionsArrayLength - 1;
    for (let j = 0; j < partitionCount; j += 1) {
      partitionIndex = request.readInt32BE(cursor);
      cursor += 4;

      const { value: recordBatchesSize, bytesRead: recordBatchesSizeBytes } = readUnsignedVarint(request, cursor);
      cursor += recordBatchesSizeBytes;

      const actualRecordBatchBytesLength = Math.max(0, Number(recordBatchesSize) - 1);
      recordBatchBytes = request.subarray(cursor, cursor + actualRecordBatchBytesLength);
      cursor += actualRecordBatchBytesLength;

      if (cursor < request.length) {
        const { value: tag, bytesRead } = readUnsignedVarint(request, cursor);
        if (tag === 0) {
          cursor += bytesRead;
        }
      }
    }

    if (cursor < request.length) {
      const { value: tag, bytesRead } = readUnsignedVarint(request, cursor);
      if (tag === 0) {
        cursor += bytesRead;
      }
    }
  }

  if (cursor < request.length) {
    const { value: tag, bytesRead } = readUnsignedVarint(request, cursor);
    if (tag === 0) {
      cursor += bytesRead;
    }
  }

  return { topicName, partitionIndex, recordBatchBytes, offset: cursor, transactionalId, acks };
};

const parseFetchRequest = (request, offset) => {
  let cursor = offset;

  cursor += 4;
  cursor += 4;
  cursor += 4;
  cursor += 1;
  cursor += 4;
  cursor += 4;

  const { value: topicsArrayLength, bytesRead: topicsArrayBytesRead } = readUnsignedVarint(request, cursor);
  cursor += topicsArrayBytesRead;

  const topics = [];
  const topicCount = topicsArrayLength === 0 ? 0 : topicsArrayLength - 1;

  for (let i = 0; i < topicCount; i += 1) {
    const { value: topicUuid, offset: uuidOffset } = readUuid(request, cursor);
    cursor = uuidOffset;

    const { value: partitionsArrayLength, bytesRead: partitionsArrayBytesRead } = readUnsignedVarint(request, cursor);
    cursor += partitionsArrayBytesRead;

    const partitionCount = partitionsArrayLength === 0 ? 0 : partitionsArrayLength - 1;
    let partitionId = 0;

    for (let j = 0; j < partitionCount; j += 1) {
      partitionId = request.readInt32BE(cursor);
      cursor += 4;
      cursor += 4;
      cursor += 8;
      cursor += 4;
      cursor += 8;
      cursor += 4;

      if (cursor < request.length) {
        const { value: tag, bytesRead } = readUnsignedVarint(request, cursor);
        if (tag === 0) {
          cursor += bytesRead;
        }
      }
    }

    if (cursor < request.length) {
      const { value: tag, bytesRead } = readUnsignedVarint(request, cursor);
      if (tag === 0) {
        cursor += bytesRead;
      }
    }

    topics.push({ topicUuid, partitionId });
  }

  return { topics, offset: cursor };
};

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

      if (requestApiKey === 0) {
        const { topicName, partitionIndex, recordBatchBytes } = parseProduceRequest(request, offset);
        const validProduceResponse = getValidIotProduceResponse(topicName, partitionIndex);

        if (validProduceResponse) {
          appendProduceRecordBatchToDisk(topicName, partitionIndex, recordBatchBytes);
        }

        const errorCode = validProduceResponse ? 0 : 3;
        const baseOffset = validProduceResponse ? 0 : -1;
        const logAppendTimeMs = validProduceResponse ? -1 : -1;
        const logStartOffset = validProduceResponse ? 0 : -1;
        const validPartitionIndex = validProduceResponse ? validProduceResponse.partitionIndex : partitionIndex;

        const topicResponse = Buffer.concat([
          writeCompactString(topicName || ""),
          writeUnsignedVarint(2),
          Buffer.concat([
            writeInt32(validPartitionIndex),
            writeInt16(errorCode),
            writeInt64(baseOffset),
            writeInt64(logAppendTimeMs),
            writeInt64(logStartOffset),
            writeUnsignedVarint(1),
            writeUnsignedVarint(0),
            writeUnsignedVarint(0),
          ]),
          writeUnsignedVarint(0),
        ]);

        responseBody = Buffer.concat([
          writeUnsignedVarint(2),
          topicResponse,
          writeInt32(0),
          writeUnsignedVarint(0),
        ]);
      } else if (requestApiKey === 1) {
        const { topics } = parseFetchRequest(request, offset);

        if (topics.length === 0) {
          responseBody = Buffer.concat([
            writeInt32(0),
            writeInt16(0),
            writeInt32(0),
            writeUnsignedVarint(1),
            writeUnsignedVarint(0),
          ]);
        } else {
          const knownTopicUuids = getKnownTopicUuids();
          const topicResponses = topics.map(({ topicUuid, partitionId }) => {
            const uuid = topicUuid || "00000000-0000-0000-0000-000000000000";
            const partitionErrorCode = knownTopicUuids.has(uuid) ? 0 : 100;
            const recordBatchBytes = readRecordBatchBytesForPartition(uuid, partitionId ?? 0);

            return Buffer.concat([
              writeUuid(uuid),
              writeUnsignedVarint(2),
              writeInt32(partitionId ?? 0),
              writeInt16(partitionErrorCode),
              writeInt64(-1),
              writeInt64(-1),
              writeInt64(-1),
              writeUnsignedVarint(1),
              writeInt32(-1),
              writeUnsignedVarint(recordBatchBytes.length + 1),
              recordBatchBytes,
              writeUnsignedVarint(0),
              writeUnsignedVarint(0),
            ]);
          });

          responseBody = Buffer.concat([
            writeInt32(0),
            writeInt16(0),
            writeInt32(0),
            writeUnsignedVarint(topics.length + 1),
            ...topicResponses,
            writeUnsignedVarint(0),
          ]);
        }
      } else if (requestApiKey === 18) {
        console.error("API_VERSIONS_REQUEST", { requestApiVersion, requestLength: request.length, requestHex: request.toString("hex") });

        const errorCode = requestApiVersion >= 0 && requestApiVersion <= 4 ? 0 : 35;
        const apiKeys = [
          [0, 0, 11],
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

      const responseHeader = [0, 1, 75].includes(requestApiKey)
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
