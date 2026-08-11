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

    const correlationId = buffer.readInt32BE(8);
    const response = Buffer.alloc(8);
    response.writeInt32BE(0, 0);
    response.writeInt32BE(correlationId, 4);

    connection.end(response);
  });
});

server.listen(9092, "127.0.0.1");
