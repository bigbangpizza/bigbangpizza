-- Horário da loja: uma regra só no banco (loja_aberta_agora), usada pela Pizza do Dia
-- e pela trava de pedido. "Aberta manualmente" vale até configuracoes.modo_loja_ate
-- (o admin grava; padrão 23h do dia); sem data válida ou vencida, volta ao automático.
-- Pedido do site/Luiza (anon) com a loja fechada é recusado; pedido manual do admin não.

insert into public.configuracoes (chave, valor)
select 'modo_loja_ate', '' where not exists (select 1 from public.configuracoes where chave = 'modo_loja_ate');

create or replace function public.loja_aberta_agora(p_agora timestamptz default now())
returns boolean language sql stable security definer set search_path to 'public' as $$
  with c as (
    select coalesce((select valor from configuracoes where chave = 'modo_loja'), 'automatico') as modo,
           (select valor from configuracoes where chave = 'modo_loja_ate') as ate
  ), a as (
    select extract(dow from p_agora at time zone 'America/Bahia')::int as dow,
           extract(hour from p_agora at time zone 'America/Bahia')::int as hora
  )
  select case
    when c.modo = 'fechada' then false
    when c.modo = 'aberta' and c.ate ~ '^\d{4}-\d{2}-\d{2}T' and p_agora < c.ate::timestamptz then true
    else a.dow in (0, 4, 5, 6) and a.hora >= 18 and a.hora < 23
  end
  from c, a;
$$;

create or replace function public.pizza_do_dia_vigente(p_agora timestamp with time zone default now())
returns pizza_do_dia language sql stable security definer set search_path to 'public' as $$
  select p.* from pizza_do_dia p
  where loja_aberta_agora(p_agora) and p.ativo
    and p.dia_semana = extract(dow from p_agora at time zone 'America/Bahia')::int
  limit 1;
$$;

create or replace function public.pedidos_aplicar_regras_v2()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  r jsonb;
  v_nota text := '';
begin
  if coalesce(auth.role(), 'anon') <> 'anon' then return new; end if;
  -- Site e Luiza: com a loja fechada o pedido não entra (caso de 30–31/10).
  if not loja_aberta_agora() then
    raise exception 'Loja fechada: pedido não registrado.' using errcode = 'P0001';
  end if;
  r := calcular_checkout_v2(new.itens_json, new.bairro, new.cupom, new.whatsapp, new.bairro = 'Retirada no local');
  if new.cupom is not null and not coalesce((r->'cupom'->>'valido')::boolean, false) then
    v_nota := v_nota || '[Sistema] Cupom ' || new.cupom || ' não aplicado: ' || coalesce(r->'cupom'->>'motivo', 'inválido') || ' ';
    new.cupom := null;
  end if;
  if r->'itens_fora_do_cardapio' is not null and jsonb_typeof(r->'itens_fora_do_cardapio') = 'array' then
    v_nota := v_nota || '[Sistema] Item fora do cardápio (conferir o preço): ' || (select string_agg(x, ', ') from jsonb_array_elements_text(r->'itens_fora_do_cardapio') x) || ' ';
  end if;
  new.itens_json := r->'itens';
  if (r->>'bairro_reconhecido')::boolean is false then
    if v_nota <> '' then new.observacao := trim(coalesce(new.observacao || E'\\n', '') || v_nota); end if;
    return new;
  end if;
  if abs(coalesce(new.total, 0) - (r->>'total')::numeric) > 0.009 then
    v_nota := v_nota || '[Sistema] Valores recalculados (enviado: R$ ' || coalesce(new.total, 0) || ').';
  end if;
  new.subtotal := (r->>'subtotal')::numeric;
  new.desconto := (r->>'desconto')::numeric;
  new.frete := (r->>'frete')::numeric;
  new.total := (r->>'total')::numeric;
  if v_nota <> '' then new.observacao := trim(coalesce(new.observacao || E'\\n', '') || v_nota); end if;
  return new;
end;
$function$;

-- O site e a Luiza (chave pública) precisam ler até quando vale o "aberta".
drop policy anon_select_conf on public.configuracoes;
create policy anon_select_conf on public.configuracoes for select to anon using (chave = any (array[
  'cor_principal','cor_destaque','cor_gold','hero_slogan','hero_destaque','hero_subtitulo','hero_foto_posicao',
  'hero_overlay','hero_foto','info_whatsapp','info_instagram','info_horario','info_rodape_slogan','subtitulo_salgadas',
  'subtitulo_doces','borda_preco_salgada','borda_preco_doce','frete_padrao','frete_gratis_minimo','oferta_doce_ativa',
  'oferta_doce_preco','modo_loja','modo_loja_ate','bairros_updated_at']));
