# oasprint

Gerador de tipos OpenAPI e transporte HTTP compacto, criado para os contratos do G4 Atlas. Outros projetos podem usá-lo dentro do mesmo escopo de contratos. Não busca implementar toda a especificação OpenAPI.

O gerador escreve `.d.ts` diretamente, sem carregar o compilador TypeScript. As assinaturas já têm o formato `client.method["/route"](init)`, retornam o corpo da resposta e resolvem as projeções de request/response durante a geração. O browser recebe o transporte e as funções das rotas acessadas; não recebe os contratos nem uma tabela de endpoints.

O transporte usa `fetch`, `Request`, `Headers`, `FormData` e `URLSearchParams` nativos, sem dependências JavaScript de produção. `openapi-fetch` fica apenas no desenvolvimento, como referência dos testes de compatibilidade. Os tipos públicos também são independentes dele.

## Instalação e uso

```sh
pnpm add oasprint
pnpm exec oasprint --config oasprint.json
```

```json
{
  "apis": {
    "service": {
      "root": "./openapi.json",
      "x-openapi-ts": { "output": "./src/service-schema.d.ts" }
    }
  }
}
```

Roots e outputs são relativos ao diretório da configuração. Configurações e contratos aceitam apenas JSON. Para uma API remota, `root` também aceita URL HTTP/HTTPS. Contratos idênticos não são regravados; todos são preparados antes de qualquer escrita.

```ts
import { ApiClientError, createTypedApiClient } from "oasprint";
import type { client } from "./service-schema";

const api = createTypedApiClient<client>({
  baseUrl: "https://api.example.com",
  service: "Example",
  errorClass: ApiClientError,
});

// A rota e seus parâmetros vêm do contrato gerado.
const item = await api.get["/items/{id}"]({
  params: { path: { id: "123" } },
});
```

`ApiRequest`, `ApiQuery`, `ApiPathParams`, `ApiBody`, `ApiResponse` e `ApiListItem` derivam tipos do client. `ApiClientFromPaths` adapta contratos provisórios ainda no formato `paths`.

## Integração com o Atlas

O pacote contém a geração, os tipos derivados e o transporte. A aplicação mantém autenticação/refresh, headers, preparação de uploads e a validação dos erros da Accounts. `errorClass` é obrigatório: o Atlas injeta seu `ApiClientError`, sem carregar a classe genérica no bundle. `fetch` injeta o transporte autenticado e `onRequest(request, schemaPath)` prepara uploads antes dele.

A CLI preserva o protocolo `HUB_PREPARED_OPENAPI_CONFIG`: um snapshot preparado evita novos downloads. Sem esse snapshot, carrega `.env` do diretório atual, se existir. Resolve as regras `resolve.http.headers` da configuração; valores podem vir de `value` ou `envVariable`. Para credenciais, use padrões de URL com host exato, como nos contratos do Atlas. Apenas falhas de rede, HTTP 429 e 5xx repetem o download, até três tentativas.

```ts
import { generateClient } from "oasprint/generator";
import { generateClients } from "oasprint/generate";

const declarations = generateClient(document);
await generateClients({ configPath: "oasprint.json" });
```

Os subpaths de geração são exclusivos de Node. Importar `oasprint` no browser não carrega binários, arquivos, downloads nem compiladores. `generateClients` não carrega `.env` nem imprime o resumo; avisos de retry vão para stderr. Os dois subpaths apenas chamam o executável Rust.

## Contratos suportados

OpenAPI 3.0/3.1 com referências locais, métodos GET/POST/PUT/PATCH/DELETE, parâmetros herdados, composições, enums, nullable, discriminadores com mapping e projeções recursivas de `readOnly`/`writeOnly`. Multipart aceita `FormData`. Os formatos `float`, `decimal` e `Date` publicados pela BrasilAPI são tratados como `number`, `number` e `string`. O padrão de paginação do Nest usado pelo Atlas é resolvido durante a geração.

Referências externas precisam ser preparadas em um único documento. Referências quebradas e tipos não suportados falham na geração. Recursos como HEAD/OPTIONS, `parseAs`, middleware genérico e toda a semântica JSON Schema não fazem parte do contrato deste pacote.

Respostas de sucesso são JSON ou vazias. Erros carregam JSON, texto ou `undefined` na classe injetada. O parser usa `response.json()` com `Content-Length` e preserva o tratamento de corpos vazios sem esse header. Rejeições de rede e cancelamentos propagam sem serem embrulhados.

O transporte compila placeholders e estilos por rota e reaproveita os estilos de query entre parâmetros da mesma chamada. Alterações nas opções de query são refletidas na chamada seguinte. Aceita path `simple`, `label` e `matrix`; query aceita arrays repetidos, CSV, espaços ou pipes, objetos `form`/`deepObject` e `allowReserved`. `querySerializer` e `pathSerializer` permitem formatos próprios; objetos aninhados em parâmetros expandidos exigem um serializer próprio. Parâmetros adicionais são anexados com `&` quando a rota já contém query.

Headers escalares seguem a prioridade configuração → chamada → `params.header`; arrays em records acumulam valores e `null` remove um header. JSON recebe `Content-Type` padrão somente quando não há configuração explícita, inclusive em array. Multipart usa o boundary do browser e formulários URL-encoded usam `URLSearchParams`. Alterações de `bodySerializer(body, headers)`, inclusive remoções de headers configurados, são preservadas ao criar o `Request`.

## Geração nativa

O executável Rust carrega a configuração e o `.env`, resolve referências, baixa as APIs em paralelo e emite os tipos. Não executa Node, JavaScript, TypeScript ou um parser TypeScript. O launcher npm apenas seleciona e inicia o binário da plataforma. Também é possível chamar esse binário diretamente, sem Node instalado.

O `.env` preserva valores literais com `$`, comentários, aspas e prioridade das variáveis já existentes no processo. O snapshot preparado pelo Hub dispensa o `.env` e novos downloads quando usa roots locais. Redirects para outra origem removem os headers de credenciais. Erros de download exibem apenas a origem.

Os pacotes opcionais `oasprint-linux-{x64,arm64}`, `oasprint-darwin-{x64,arm64}` e `oasprint-win32-{x64,arm64}` fornecem os binários. Linux usa musl estático para dispensar uma versão específica da glibc. A instalação do consumidor não compila Rust nem executa download em postinstall; mantenha dependências opcionais habilitadas.

A publicação dos dois pacotes Windows está suspensa enquanto o npm revisa o bloqueio dos nomes. Seus manifests têm `private: true`, que impede a publicação, mas os binários continuam sendo compilados e testados na CI. O principal declara apenas os quatro opcionais Linux/macOS já publicados; nomes Windows sem propriedade comprovada não entram nas dependências públicas. O runtime funciona no browser em qualquer sistema, e a CLI publicada atende Linux/macOS. Em Windows nativo, a CLI depende da liberação dos pacotes; o tarball autocontido de desenvolvimento mantém os seis binários. Após a liberação, remova `private` dos manifests Windows, publique-os e adicione os opcionais ao principal em uma versão nova.

Os builds Linux com musl usam mimalloc para evitar contenção de alocações entre os workers, com prioridade ao tempo de geração. Isso pode aumentar o pico de RAM em máquinas com transparent huge pages. Uma configuração com uma única API roda na própria thread. A emissão reutiliza referências e aliases já resolvidos, mantém o grafo de projeções em vetores e evita cópias dos schemas. Essas otimizações preservam os bytes gerados e o mtime de outputs idênticos.

O perfil release usa `opt-level = 2`, LTO completo e uma unidade de geração de código para reduzir os executáveis. A compilação para distribuir o pacote fica mais demorada; a instalação e a geração dos consumidores usam o binário pronto. O perfil mantém o tratamento de panics e o suporte às seis plataformas.

## Desenvolvimento e publicação

Instale Rust 1.99.1 e o target da plataforma. Em Linux x64, instale também `musl-tools` e execute `rustup target add --toolchain 1.99.1 x86_64-unknown-linux-musl`. O build seleciona a toolchain explicitamente, mesmo quando chamado da raiz.

```sh
pnpm install --frozen-lockfile
pnpm run check
npm pack --dry-run
# Tarball autocontido com todas as plataformas para integrar antes da publicação:
pnpm run pack:local
```

O tsrs continua apenas no desenvolvimento, para compilar e verificar os tipos do transporte. Em Windows ARM, essa compilação usa o TypeScript 6 já instalado, pois o tsrs não distribui binário para esse host. Não participa do executável gerador. Os testes comparam a emissão Rust com uma cópia do gerador anterior usada como referência, além de verificar tipos, transporte, downloads e configuração. `OPENAPI_CORPUS` habilita a comparação dos sete contratos reais locais, sem incluí-los no pacote.

Para comparar dois executáveis, use `node scripts/benchmark-native.mjs <config.json> <antes> <depois>`. O script exige roots locais, usa outputs temporários e mede 30 processos novos por versão em ordem alternada. Também exige saídas idênticas. O JSON resultante contém as amostras, a mediana e o p95; downloads não entram na medição.

O [workflow `ci.yml`](.github/workflows/ci.yml) compila, verifica e testa as seis plataformas em pushes e pull requests. Depois instala os tarballs em consumidores limpos nas mesmas plataformas, sem scripts de instalação nem compilador Rust. O artifact `npm-packages` reúne os sete pacotes aprovados. A publicação reutiliza esses arquivos, sem rebuild.

Tags `v<versão>` publicam automaticamente no npm por OIDC, depois de todas as verificações. O job de publicação tem permissão `id-token: write`; os demais têm apenas leitura do repositório. Versões preliminares recebem a dist-tag `next`; as demais, `latest`. `workflow_dispatch` apenas valida e gera os pacotes.

Na primeira publicação, a conta npm precisa criar os pacotes com publicação habilitada. Baixe o artifact `npm-packages` de uma execução aprovada da branch `main`, faça `npm login` e publique os tarballs nativos cujos manifests não têm `private: true` com `npm publish <arquivo.tgz> --access public --ignore-scripts`; publique `oasprint-<versão>.tgz` por último. Depois, nas configurações de **cada pacote publicado** no npm, cadastre o [trusted publisher](https://docs.npmjs.com/trusted-publishers/):

- Provider: GitHub Actions.
- Organization/user: `Thiagolino8`.
- Repository: `oasprint`.
- Workflow filename: `ci.yml`.
- Environment: vazio; este workflow não usa environment.
- Habilite publicação direta (`Allow npm publish`), pois a permissão padrão de staging não conclui este release.

Ative o vínculo com uma publicação OIDC dentro do prazo informado pelo npm. Para isso, após o bootstrap, prepare a versão seguinte e envie sua tag. A publicação automática não precisa de `NPM_TOKEN` nos secrets do GitHub. O npm gera a provenance para estes pacotes públicos a partir do repositório público.

Para uma versão nova, atualize `package.json` (incluindo `optionalDependencies`), os seis `npm/*/package.json`, `native/Cargo.toml` e a entrada do próprio pacote em `native/Cargo.lock`. Atualize o `pnpm-lock.yaml` com `pnpm install --lockfile-only`, execute `pnpm run check` e envie o commit. Com a CI aprovada, crie e envie a tag correspondente:

```sh
git tag v0.1.1
git push origin v0.1.1
```

O release recusa versões, manifests, licenças ou entrypoints divergentes e valida todos os sete artifacts. Na publicação, ignora os manifests com `private: true`, envia os demais nativos e aguarda seu processamento em paralelo antes de enviar o principal. Confere se cada versão está disponível no registro público e se sua integridade corresponde ao artifact; apenas staging não conta como publicação concluída. Respostas 404 têm espera limitada para propagação; outros erros e divergências interrompem o release. Se uma execução publicar apenas parte deles, use **Re-run failed jobs** nessa execução: os tarballs já publicados só são ignorados quando a integridade corresponde exatamente ao artifact. Se houver divergência, use uma versão nova; versões npm não podem ser substituídas.

O `prepack` local exige build, lint e testes. O tarball de `pack:local` inclui os seis binários para integrar na aplicação antes da publicação. Antes de executá-lo, extraia os tarballs nativos produzidos pelo workflow nos diretórios correspondentes `npm/<plataforma>/`; o comando falha se faltar alguma plataforma. Esse tarball autocontido não é usado pelo release público.

Licenciado sob a [MIT](LICENSE).
