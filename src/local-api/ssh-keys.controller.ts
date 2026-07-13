import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';

/** Local SSH key management — private keys stay on this machine (same service as CLI). */
@Controller('api/ssh-keys')
export class SshKeysController {
  constructor(private readonly keys: VopsSshKeysService) {}

  @Get()
  list() {
    return this.keys.list();
  }

  @Post()
  create(@Body() body: { name: string }) {
    return this.keys.create(body.name);
  }

  @Post('import')
  import(
    @Body() body: { name: string; from?: string; pub?: string; publicKey?: string },
  ) {
    return this.keys.import(body.name, {
      privateKeyPath: body.from,
      publicKeyPath: body.pub,
      publicKey: body.publicKey,
    });
  }

  @Post('connect')
  connect(
    @Body() body: { provider: string; server: string; user?: string; key?: string },
  ) {
    return this.keys.connectInfo(body.provider, body.server, {
      user: body.user,
      keyName: body.key,
    });
  }

  @Post(':name/register')
  register(@Param('name') name: string, @Body() body: { provider: string }) {
    return this.keys.register(body.provider, name);
  }

  @Delete(':name')
  remove(@Param('name') name: string) {
    this.keys.remove(name);
    return { deleted: name };
  }
}
