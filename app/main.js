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

    const response = Buffer.alloc(10);
    response.writeInt32BE(0, 0);
    response.writeInt32BE(correlationId, 4);
    response.writeInt16BE(errorCode, 8);

    connection.end(response);
  });
});

server.listen(9092, "127.0.0.1");
