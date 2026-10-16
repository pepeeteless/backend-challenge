import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";

/** Ponto de extensao HTTP. Autenticacao adiada explicitamente neste desafio. */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    // Futuro: validar token do IdP e associar a identidade verificada ao request.
    // Este no-op permite acesso anonimo; nao comprova identidade nem autorizacao.
    return true;
  }
}
