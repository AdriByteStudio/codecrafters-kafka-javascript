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

      const requestApiVersion = request.readInt16BE(6);
      const correlationId = request.readInt32BE(8);
      const errorCode = requestApiVersion >= 0 && requestApiVersion <= 4 ? 0 : 35;

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

      const arrayLengthBuffer = Buffer.from([3]);
      const throttleTimeBuffer = Buffer.alloc(4);
      throttleTimeBuffer.writeInt32BE(0, 0);
      const tagBuffer = Buffer.from([0]);

      const responseBody = Buffer.concat([
        errorCodeBuffer,
        arrayLengthBuffer,
        writeApiKeyEntry(18, 0, 4),
        writeApiKeyEntry(75, 0, 0),
        throttleTimeBuffer,
        tagBuffer,
      ]);

      const response = Buffer.alloc(4 + 4 + responseBody.length);
      response.writeInt32BE(4 + responseBody.length, 0);
      response.writeInt32BE(correlationId, 4);
      responseBody.copy(response, 8);

      connection.write(response);
    }
  });
});

server.listen(9092, "127.0.0.1");
