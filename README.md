# arte-jco

Gerador de imagem no padrão **Print / Feed** do Jornal da Cidade Online.
Substitui a **Placid** no workflow "Divulgação POSTA NA HORA": recebe a foto da
matéria + o título e devolve um `image_url` público (JPEG 1080×1350), pronto pra
ser consumido pelo Instagram e Facebook Graph API.

## Endpoint

`POST /render`

```json
{
  "imagem": "https://.../foto-da-materia.jpg",
  "titulo": "URGENTE: PF faz operação contra grupo..."
}
```

Resposta:

```json
{ "image_url": "https://arte-jco.realiser.com.br/img/1783085089811-83ab1dea.jpg" }
```

`GET /` → health check. `GET /img/<arquivo>.jpg` → serve a imagem gerada.

## Layout (fixo, medido na arte original)

Canvas 1080×1350 (4:5):

| Região                         | Y            | Observação                              |
|--------------------------------|--------------|-----------------------------------------|
| Chrome (cabeçalho + barra)     | 0–214        | overlay `assets/chrome.png` (fixo)      |
| Título (auto-fit, caixa alta)  | 226–640      | Roboto 70px base, caixa 960px, centrado |
| Handle `@jornaldacidadeonline`  | ~688         | cinza, esquerda                         |
| Foto                           | 705–1350     | cover-crop da `imagem`                  |

- Fonte do título: **Roboto Regular** (identificada por largura — o padrão do JCO
  não é Arial; Roboto bate a ~1%). Empacotada em `assets/`, não depende de fonte
  do sistema.
- Título: caixa alta, centralizado, base 70px, **encolhe só se não couber**.

## Variáveis de ambiente

| Var               | Default                        | Descrição                                   |
|-------------------|--------------------------------|---------------------------------------------|
| `PORT`            | `3002`                         | porta HTTP                                  |
| `PUBLIC_BASE_URL` | `http://localhost:PORT`        | base pública p/ montar o `image_url`        |
| `HANDLE`          | `@jornaldacidadeonline`         | handle exibido na arte                      |
| `JPEG_QUALITY`    | `0.92`                         | qualidade do JPEG (0–1)                     |
| `RETENTION_HOURS` | `24`                           | apaga imagens geradas mais antigas que isso |
| `RENDER_TOKEN`    | *(vazio)*                      | se setado, `/render` exige `Authorization: Bearer <token>`. **Recomendado em produção.** |
| `FETCH_TIMEOUT_MS`| `10000`                        | timeout do download da foto (ms)            |
| `MAX_IMAGE_MB`    | `15`                           | tamanho máximo da foto baixada              |

> Se `RENDER_TOKEN` não for definido, o `/render` fica aberto (o serviço loga um aviso no boot).

## Deploy no EasyPanel

1. Suba o repositório (ex.: `portalrealiser/arte-jco`).
2. No EasyPanel, projeto **realiser** → novo App → source = GitHub, build = **Dockerfile**.
3. Env: `PUBLIC_BASE_URL=https://arte-jco.realiser.com.br`, `PORT=3002`.
4. Domínio: aponte `arte-jco.realiser.com.br` para a porta **3002** (Traefik do EasyPanel).
5. (Opcional) Volume persistente em `/app/public/img` se quiser manter as imagens
   entre redeploys — não é obrigatório, o n8n posta em segundos.

## Integração no n8n (troca da Placid)

No workflow "Divulgação POSTA NA HORA", **substitua o nó Placid** ("Create an image
from a template") por um **HTTP Request**:

- Method: `POST`
- URL: `https://arte-jco.realiser.com.br/render`
- Header (se usar `RENDER_TOKEN`): `Authorization: Bearer <seu-token>`
- Body (JSON):
  - `imagem` = `{{ $json.imagem }}`  (o `og:image` já extraído)
  - `titulo` = `{{ $json.body.titulo }}`

O nó devolve `{{ $json.image_url }}`. Todos os nós seguintes (Merge1, Edit Fields1,
"CRIA O POST", "POSTA NO FACEBOOK OFICIAL", "LINK NO COMENTÁRIO") já leem
`image_url` — nada mais muda.

## Rodar local

```bash
npm install
PUBLIC_BASE_URL=http://localhost:3002 npm start
curl -X POST http://localhost:3002/render \
  -H 'Content-Type: application/json' \
  -d '{"imagem":"https://exemplo.com/foto.jpg","titulo":"Teste de manchete"}'
```

## Ajustes finos

- Título curto que deveria ficar maior? A base é fixa em 70px (calibrada no card de
  referência). Se aparecer um caso em que o JCO usa fonte maior, dá pra trocar a
  regra de escala em `TITLE_MAX_FONT` / lógica de `fitTitle` no `server.js`.
- Quer chrome sem artefato de JPEG? Substitua `assets/chrome.png` por uma versão
  limpa do cabeçalho (mesmas dimensões, 1080×214).
