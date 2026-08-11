import net from "net";

const server = net.createServer((connection) => {
  let buffer = Buffer.alloc(0);

  connection.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    if (buffer.length < 4) {
      return;
    }

    const messageSize = buffer.readInt32BE(0);
    if (buffer.length < 4 + messageSize) {
      return;
    }

    const requestApiVersion = buffer.readInt16BE(6);
    const correlationId = buffer.readInt32BE(8);
    const errorCode = requestApiVersion >= 0 && requestApiVersion <= 4 ? 0 : 35;

    const responseBody = Buffer.alloc(15);
    responseBody.writeInt16BE(errorCode, 0);
    responseBody.writeInt8(2, 2);
    responseBody.writeInt16BE(18, 3);
    responseBody.writeInt16BE(0, 5);
    responseBody.writeInt16BE(4, 7);
    responseBody.writeInt8(0, 9);
    responseBody.writeInt32BE(0, 10);
    responseBody.writeInt8(0, 14);

    const response = Buffer.alloc(4 + 4 + responseBody.length);
    response.writeInt32BE(4 + responseBody.length, 0);
    response.writeInt32BE(correlationId, 4);
    responseBody.copy(response, 8);

    connection.end(response);
  });
});

server.listen(9092, "127.0.0.1");
