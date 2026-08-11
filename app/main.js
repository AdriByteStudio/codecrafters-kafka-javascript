import net from "net";

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
      const errorCode = requestApiKey === 75 ? 3 : (requestApiVersion >= 0 && requestApiVersion <= 4 ? 0 : 35);

      const writeApiKeyEntry = (apiKey, minVersion, maxVersion) => {
        const entry = Buffer.alloc(7);
        entry.writeInt16BE(apiKey, 0);
        entry.writeInt16BE(minVersion, 2);
        entry.writeInt16BE(maxVersion, 4);
        entry.writeInt8(0, 6);
        return entry;
      };

      const errorCodeBuffer = Buffer.alloc(2);
      errorCodeBuffer.writeInt16BE(errorCode, 0);

      const apiVersionsResponseBody = Buffer.concat([
        errorCodeBuffer,
        Buffer.from([3]),
        writeApiKeyEntry(18, 0, 4),
        writeApiKeyEntry(75, 0, 0),
        Buffer.from([0, 0, 0, 0]),
        Buffer.from([0]),
      ]);

      const responseHeader = Buffer.alloc(5);
      responseHeader.writeInt32BE(correlationId, 0);
      responseHeader.writeInt8(0, 4);

      const responseBody = requestApiKey === 18
        ? apiVersionsResponseBody
        : (() => {
            let offset = 12;
            const clientIdLength = request.readInt16BE(offset);
            offset += 2;
            if (clientIdLength >= 0) {
              offset += clientIdLength;
            }

            let topicName = "";
            for (let i = offset; i < request.length; i += 1) {
              const lengthPrefix = request[i];
              if (lengthPrefix <= 0) {
                continue;
              }
              const candidate = request.subarray(i + 1, i + 1 + lengthPrefix).toString("utf8");
              if (/^[a-zA-Z0-9._-]+$/.test(candidate)) {
                topicName = candidate;
                break;
              }
            }

            const topicNameBuffer = Buffer.from(topicName, "utf8");
            const topicNameLengthBuffer = Buffer.from([topicNameBuffer.length]);
            const topicIdBuffer = Buffer.alloc(16);
            const partitionsArrayBuffer = Buffer.from([1]);
            const topicAuthorizedOperationsBuffer = Buffer.alloc(4);
            topicAuthorizedOperationsBuffer.writeInt32BE(0, 0);
            const nextCursorBuffer = Buffer.from([0xff]);
            const tagBuffer = Buffer.from([0]);

            return Buffer.concat([
              Buffer.from([0, 0, 0, 0]),
              Buffer.from([2]),
              Buffer.from([0x00, 0x03]),
              topicNameLengthBuffer,
              topicNameBuffer,
              topicIdBuffer,
              Buffer.from([0]),
              partitionsArrayBuffer,
              topicAuthorizedOperationsBuffer,
              tagBuffer,
              nextCursorBuffer,
              tagBuffer,
            ]);
          })();

      const response = Buffer.alloc(4 + responseHeader.length + responseBody.length);
      response.writeInt32BE(responseHeader.length + responseBody.length, 0);
      responseHeader.copy(response, 4);
      responseBody.copy(response, 4 + responseHeader.length);

      connection.write(response);
    }
  });
});

server.listen(9092, "127.0.0.1");
