import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  const port = process.env.PORT ?? 3001;
  // Bind to loopback only. This is the first of the two layers protecting the
  // machine tier: even a leaked X-Internal-Key is useless from off-box, and a
  // service that is never exposed cannot be reached by a firewall mistake.
  await app.listen(port, '127.0.0.1');
  console.log(`agent-service listening on :${port}`);
}
void bootstrap();
