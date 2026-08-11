import { temServiceRoleConfigurada, selectComoAdmin, atualizarComoAdmin } from './supabaseAdmin.js';
import { enviarTexto } from './evolutionApi.js';
import { obterConfigBotAdmin } from './botConfig.js';

const NOTA_MAXIMA_ALERTA = 3; // nota <= 3 (de 1 a 5) dispara alerta

/**
 * Rotina periódica (a cada 5 min) que verifica avaliações com nota baixa
 * (≤ 3) ainda não alertadas e avisa o Gabriel. A tabela `avaliacoes` tem
 * leitura pública (é assim que o site exibe as avaliações), mas não tem
 * policy de UPDATE pra anon — por isso usamos a service_role key aqui
 * também (pra poder marcar `alerta_enviado=true` depois de avisar),
 * consistente com as outras rotinas agendadas.
 */
export async function verificarAvaliacoesRuins() {
  if (!temServiceRoleConfigurada()) {
    console.warn('[badReviewsJob] SUPABASE_SERVICE_ROLE_KEY não configurada — pulando verificação de avaliações.');
    return { pulado: true };
  }

  // Número configurável na aba "Configurações do Bot" do admin.html
  // (tabela `configuracoes`), com fallback pra GABRIEL_WHATSAPP_NUMBER
  // enquanto o campo não é preenchido por lá.
  const { alertaWhatsappNumero } = await obterConfigBotAdmin();
  if (!alertaWhatsappNumero) {
    console.warn('[badReviewsJob] Nenhum número de alerta configurado (admin ou GABRIEL_WHATSAPP_NUMBER) — pulando verificação de avaliações.');
    return { pulado: true };
  }

  let avaliacoes;
  try {
    avaliacoes = await selectComoAdmin(
      'avaliacoes',
      `select=id,nome,texto,estrelas&estrelas=lte.${NOTA_MAXIMA_ALERTA}&alerta_enviado=is.false`
    );
  } catch (err) {
    console.error('[badReviewsJob] falha ao buscar avaliações — abortando desta vez:', err);
    return { erro: true };
  }

  let alertados = 0;
  let falhas = 0;

  for (const avaliacao of avaliacoes) {
    try {
      const msg = `⭐ Avaliação baixa recebida: nota ${avaliacao.estrelas}, cliente ${avaliacao.nome}, comentário: '${avaliacao.texto}'.`;
      await enviarTexto(alertaWhatsappNumero, msg);
      await atualizarComoAdmin('avaliacoes', avaliacao.id, { alerta_enviado: true });
      alertados++;
    } catch (err) {
      falhas++;
      console.error(`[badReviewsJob] falha ao processar avaliação #${avaliacao.id}:`, err);
      // segue pra próxima avaliação — erro individual não trava o lote inteiro
    }
  }

  if (alertados || falhas) {
    console.log(`[badReviewsJob] concluído: ${alertados} alerta(s) enviado(s), ${falhas} falha(s), ${avaliacoes.length} avaliação(ões) verificada(s).`);
  }
  return { alertados, falhas, totalVerificadas: avaliacoes.length };
}
