// Testes da lógica de cálculo de index.html (trecho entre os marcadores <calculo> e </calculo>).
// Rodar com: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function carregarCalculo() {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const match = html.match(/\/\/ <calculo>[\s\S]*?\/\/ <\/calculo>/);
    if (!match) throw new Error('Marcadores <calculo> não encontrados em index.html');
    return vm.runInNewContext(`${match[0]}
        ({ calculateInsulin, validarEntrada, GLICEMIA_MAX, HIPO_LIMITE, INSULINA_MIN, ALVO, TENDENCIA_INTERVALO });`);
}

const { calculateInsulin, validarEntrada, GLICEMIA_MAX, ALVO } = carregarCalculo();

// Atalho: calcula sem glicemia anterior
const calc = (glicemia, mode = 'padrao') => calculateInsulin(glicemia, null, null, mode);

test('hipoglicemia (< 70): suspende infusão e escalona a Glicose 50%', () => {
    for (const mode of ['padrao', 'cec']) {
        const r = calc(69, mode);
        assert.equal(r.rate, 0);
        assert.equal(r.bolus, 0);
        assert.equal(r.alert.type, 'danger');
        assert.match(r.alert.text, /25 mL \(12,5 g\)/);
    }
    assert.match(calc(41).alert.text, /25 mL \(12,5 g\)/);
    assert.match(calc(40).alert.text, /50 mL \(25 g\)/);
    assert.match(calc(10).alert.text, /50 mL \(25 g\)/);
});

test('70 a 99: suspende infusão nos dois modos', () => {
    for (const mode of ['padrao', 'cec']) {
        for (const g of [70, 85, 99]) {
            const r = calc(g, mode);
            assert.equal(r.rate, 0, `${mode} ${g}`);
            assert.equal(r.bolus, 0);
            assert.equal(r.alert.type, 'warning');
            assert.equal(r.adjustmentMessage, 'Infusão suspensa');
        }
    }
});

test('escala Padrão: taxa por faixa, incluindo os limites', () => {
    const esperado = [[100, 0], [140, 0], [141, 1], [180, 1], [181, 2], [220, 2],
        [221, 3], [260, 3], [261, 4], [300, 4], [301, 5], [600, 5]];
    for (const [g, taxa] of esperado) assert.equal(calc(g).rate, taxa, `glicemia ${g}`);
});

test('escala CEC: taxa por faixa, incluindo os limites', () => {
    const esperado = [[100, 0], [140, 0], [141, 2], [180, 2], [181, 4], [220, 4],
        [221, 6], [260, 6], [261, 8], [300, 8], [301, 10], [600, 10]];
    for (const [g, taxa] of esperado) assert.equal(calc(g, 'cec').rate, taxa, `glicemia ${g}`);
});

test('mensagem de alvo 140–180', () => {
    assert.match(calc(140).alert.text, /limite inferior ou abaixo do alvo/);
    assert.equal(calc(141).alert.type, 'success');
    assert.equal(calc(180).alert.type, 'success');
    assert.match(calc(181).alert.text, /acima do alvo/);
});

test('modo CEC lembra a troca para o Padrão; modo Padrão não', () => {
    assert.match(calc(200, 'cec').alert.text, /sair da CEC/);
    assert.doesNotMatch(calc(200).alert.text, /CEC/);
    // Na hipoglicemia, a mensagem é só a conduta de urgência
    assert.doesNotMatch(calc(50, 'cec').alert.text, /sair da CEC/);
});

test('bolus por faixa acima de 220 (sem glicemia anterior)', () => {
    const esperado = [[220, 0], [221, 2], [260, 2], [261, 3], [300, 3], [301, 4], [600, 4]];
    for (const [g, bolus] of esperado) assert.equal(calc(g).bolus, bolus, `glicemia ${g}`);
});

test('bolus não é dado com glicemia em queda', () => {
    const r = calculateInsulin(310, 400, 60, 'padrao');
    assert.equal(r.bolus, 0);
    assert.match(r.alert.text, /em queda: bolus não indicado/);
    // Queda pequena também suspende o bolus
    assert.equal(calculateInsulin(250, 251, 60, 'padrao').bolus, 0);
    // Estável ou subindo mantém o bolus
    assert.equal(calculateInsulin(250, 250, 60, 'padrao').bolus, 2);
    assert.equal(calculateInsulin(250, 230, 60, 'padrao').bolus, 2);
});

test('tendência é calculada por hora', () => {
    // +50 mg/dL em 60 min = +50/h → +1
    assert.equal(calculateInsulin(200, 150, 60, 'padrao').rate, 3);
    // +50 mg/dL em 30 min = +100/h → +2
    assert.equal(calculateInsulin(200, 150, 30, 'padrao').rate, 4);
    // +50 mg/dL em 120 min = +25/h → estável
    const lento = calculateInsulin(200, 150, 120, 'padrao');
    assert.equal(lento.rate, 2);
    assert.match(lento.adjustmentMessage, /Tendência estável, \+25 mg\/dL\/h/);
});

test('limites da tendência: 40 e 80 mg/dL/h', () => {
    const ajuste = (anterior) => calculateInsulin(200, anterior, 60, 'padrao').adjustment;
    assert.equal(ajuste(160), 0);   // +40/h
    assert.equal(ajuste(159), 1);   // +41/h
    assert.equal(ajuste(120), 1);   // +80/h
    assert.equal(ajuste(119), 2);   // +81/h
    assert.equal(ajuste(240), 0);   // -40/h
    assert.equal(ajuste(241), -1);  // -41/h
    assert.equal(ajuste(280), -1);  // -80/h
    assert.equal(ajuste(281), -2);  // -81/h
});

test('tendência só vale para intervalo de 30 min a 4 h', () => {
    for (const min of [29, 241]) {
        const r = calculateInsulin(200, 150, min, 'padrao');
        assert.equal(r.adjustment, 0, `${min} min`);
        assert.match(r.adjustmentMessage, /Tendência não aplicada/);
    }
    assert.equal(calculateInsulin(200, 175, 30, 'padrao').adjustment, 1);  // +25 em 30 min = +50/h
    assert.equal(calculateInsulin(200, 100, 240, 'padrao').adjustment, 0); // +100 em 4 h = +25/h
});

test('subida não aumenta a infusão abaixo do alvo', () => {
    const r = calculateInsulin(135, 60, 60, 'padrao');
    assert.equal(r.rate, 0);
    assert.equal(r.adjustment, 0);
    assert.match(r.adjustmentMessage, /abaixo do alvo/);
});

test('subida a partir de glicemia < 100 não aumenta a infusão', () => {
    const r = calculateInsulin(170, 80, 60, 'padrao');
    assert.equal(r.rate, 1);
    assert.equal(r.adjustment, 0);
    assert.match(r.adjustmentMessage, /recuperação de glicemia baixa/);
});

test('ajuste negativo nunca deixa a taxa abaixo de zero', () => {
    const r = calculateInsulin(150, 300, 60, 'padrao');
    assert.equal(r.adjustment, -2);
    assert.equal(r.rate, 0);
});

test('regras de segurança valem para todas as combinações', () => {
    const anteriores = [null, 50, 90, 120, 180, 250, 350, 600];
    const intervalos = [15, 30, 60, 120, 240, 300];
    for (const mode of ['padrao', 'cec']) {
        const taxaMax = mode === 'cec' ? 10 : 5;
        for (let g = 1; g <= GLICEMIA_MAX; g++) {
            for (const anterior of anteriores) {
                for (const min of anterior === null ? [null] : intervalos) {
                    const r = calculateInsulin(g, anterior, min, mode);
                    const caso = `${mode} g=${g} anterior=${anterior} min=${min}`;
                    assert.ok(Number.isFinite(r.rate) && r.rate >= 0, `taxa inválida: ${caso}`);
                    assert.ok(r.rate <= taxaMax + 2, `taxa acima do máximo: ${caso}`);
                    if (g < 100) assert.equal(r.rate + r.bolus, 0, `insulina com glicemia < 100: ${caso}`);
                    if (g <= ALVO.min) assert.ok(r.adjustment === undefined || r.adjustment <= 0, `ajuste positivo abaixo do alvo: ${caso}`);
                    if (g <= 220) assert.equal(r.bolus, 0, `bolus com glicemia <= 220: ${caso}`);
                    if (anterior !== null && g < anterior) assert.equal(r.bolus, 0, `bolus em queda: ${caso}`);
                    assert.ok(r.alert.text.length > 0, `alerta vazio: ${caso}`);
                }
            }
        }
    }
});

test('validarEntrada: valores válidos', () => {
    assert.deepEqual({ ...validarEntrada('250', '', '') },
        { glicemiaAtual: 250, glicemiaAnterior: null, intervaloMin: null });
    assert.deepEqual({ ...validarEntrada('250', '200', '60') },
        { glicemiaAtual: 250, glicemiaAnterior: 200, intervaloMin: 60 });
    // Tempo preenchido sem glicemia anterior é ignorado
    assert.equal(validarEntrada('250', '', '60').intervaloMin, null);
    assert.equal(validarEntrada('600', '', '').erro, undefined);
});

test('validarEntrada: glicemia atual inválida', () => {
    for (const v of ['', '0', '-5', 'abc']) assert.match(validarEntrada(v, '', '').erro, /ATUAL válido/, v);
    assert.match(validarEntrada('601', '', '').erro, /acima de 600/);
});

test('validarEntrada: glicemia anterior inválida', () => {
    for (const v of ['0', '-1', '601', 'abc']) assert.match(validarEntrada('200', v, '60').erro, /ANTERIOR inválida/, v);
});

test('validarEntrada: tempo obrigatório com glicemia anterior', () => {
    for (const v of ['', '0', '-10', '1441']) assert.match(validarEntrada('200', '150', v).erro, /TEMPO/, v);
});
