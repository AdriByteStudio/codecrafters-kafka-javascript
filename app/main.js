import net from "net";

const response = Buffer.alloc(8);
response.writeInt32BE(0, 0);
response.writeInt32BE(7, 4);

const server = net.createServer((connection) => {
  connection.end(response);
});

server.listen(9092, "127.0.0.1");
