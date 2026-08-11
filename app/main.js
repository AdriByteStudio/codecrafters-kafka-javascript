import net from "net";

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

      let responseBody;

      if (requestApiKey === 18) {
        console.error("API_VERSIONS_REQUEST", { requestApiVersion, requestLength: request.length, requestHex: request.toString("hex") });
        const errorCode = requestApiVersion >= 0 && requestApiVersion <= 4 ? 0 : 35;
        const apiKeys = [
          [18, 0, 4],
          [75, 0, 0],
        ];
        const apiKeysArrayLengthBuffer = writeUnsignedVarint(apiKeys.length + 1);
        const apiKeyEntries = Buffer.concat(
          apiKeys.map(([apiKey, minVersion, maxVersion]) => Buffer.concat([
            writeInt16(apiKey),
            writeInt16(minVersion),
            writeInt16(maxVersion),
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
        let topicName = "";
        if (offset < request.length) {
          offset += 1;
          const { value: topicsArrayLength, bytesRead } = readUnsignedVarint(request, offset);
          offset += bytesRead;
          if (topicsArrayLength > 0 && offset < request.length) {
            const { value: parsedTopicName } = readCompactString(request, offset);
            topicName = parsedTopicName ?? "";
          }
        }

        responseBody = Buffer.concat([
          writeInt32(0),
          writeUnsignedVarint(3),
          writeUnsignedVarint(2),
          writeInt16(3),
          writeCompactString(topicName),
          Buffer.alloc(16),
          writeBool(false),
          writeUnsignedVarint(0),
          writeInt32(-2147483648),
          writeUnsignedVarint(0),
          Buffer.from([0xff]),
          writeUnsignedVarint(0),
          writeUnsignedVarint(0),
        ]);
      } else {
        responseBody = Buffer.alloc(0);
      }

      const responseHeader = Buffer.alloc(4);
      responseHeader.writeInt32BE(correlationId, 0);

      const response = Buffer.alloc(4 + responseHeader.length + responseBody.length);
      response.writeInt32BE(responseHeader.length + responseBody.length, 0);
      responseHeader.copy(response, 4);
      responseBody.copy(response, 4 + responseHeader.length);

      connection.write(response);
    }
  });
});

server.listen(9092, "127.0.0.1");
