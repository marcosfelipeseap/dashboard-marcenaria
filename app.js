const express = require('express');
const { google } = require('googleapis');
const NodeCache = require('node-cache');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.set('view engine', 'ejs');
app.set('views', './views');

const myCache = new NodeCache({ stdTTL: 600 });

// --- AUTENTICAÇÃO ADAPTADA PARA O VERCEL ---
let auth;
if (process.env.GOOGLE_CREDENTIALS) {
    // Se estiver rodando no Vercel, pega as credenciais das variáveis de ambiente
    auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
} else {
    // Se estiver rodando no seu computador (Local), pega do arquivo
    auth = new google.auth.GoogleAuth({
        keyFile: 'credentials.json',
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
}

const sheets = google.sheets({ version: 'v4', auth });

// --- LÓGICA DE BUSCA DE DADOS (Exatamente a mesma que já estava funcionando) ---
async function fetchDataFromSheets() {
    const sources = [
        { type: 'SEDE', id: '17WAyG3sGud8441tlQR2E0gxWp15Ogd26zDoViv2PisE', sheetName: 'MÓVEIS ATUALIZADOS' },
        { type: 'REGIONAL', id: '1RtsILkt3MJ-djQAXSGvKOWN1VNOCCdNVNIGFYA5WrnE', sheetName: 'MARCENARIA | REGIONAL' }
    ];

    let combinedMarcenaria = [];
    let combinedProcon = [];

    await Promise.all(sources.map(async (src) => {
        try {
            const [resMain, resLink] = await Promise.all([
                sheets.spreadsheets.values.get({ spreadsheetId: src.id, range: src.sheetName, valueRenderOption: 'FORMATTED_VALUE' }).catch(() => ({ data: { values: [] } })),
                sheets.spreadsheets.values.get({ spreadsheetId: src.id, range: 'LINK DO SEI', valueRenderOption: 'FORMATTED_VALUE' }).catch(() => ({ data: { values: [] } }))
            ]);

            const linkMap = {};
            if (resLink.data.values) {
                resLink.data.values.forEach(row => {
                    let pNumRaw = (row[0] || '').replace(/\./g, '').trim(); 
                    let pLinkRaw = (row[1] || '').trim();
                    if (pNumRaw && !pNumRaw.toUpperCase().includes('PROCESSO')) linkMap[pNumRaw] = pLinkRaw;
                });
            }

            const data = resMain.data.values;
            if (!data || data.length <= 1) return;

            const headers = data[0];
            const rawData = data.slice(1);
            
            const normalize = (text) => text.toString().toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
            const map = {};
            headers.forEach((h, i) => { map[normalize(h)] = i; });
            const getCol = (name, def) => map[normalize(name)] !== undefined ? map[normalize(name)] : def;

            let idxProcesso = getCol('PROCESSO', 0);
            let idxLocal = getCol('LOCAL', 1);
            let idxTipoReal = (src.type === 'SEDE') ? getCol('TIPO', 2) : getCol('TIPO', 4);
            let idxMobilia = getCol('MOBILIA', 3);
            let idxMaterial = getCol('MATERIAL', -1);
            let idxDimensoes = getCol('DIMENSOES', -1) !== -1 ? getCol('DIMENSOES', -1) : getCol('MEDIDAS', -1);
            let idxStatus = getCol('STATUS', 12);
            let idxPrio = getCol('PRIORIDADE', 11);
            let idxDataAut = getCol('DATA DE AUTORIZACAO', 24);
            let idxPrev = getCol('PREVISAO', 20);
            let idxDem = getCol('DEMANDANTE', 22);
            let idxBen = getCol('BENEFICIARIO', 21);
            let idxDataEnt = getCol('DATA DE ENTREGA', src.type === 'SEDE' ? 23 : 19);
            let idxQtdSol = getCol('QUANTIDADE', getCol('QTD', src.type === 'SEDE' ? 7 : 11));
            let idxQtdEnt = getCol('QUANTIDADE ENTREGUE', getCol('ENTREGUE', src.type === 'SEDE' ? 18 : 12));
            let idxQtdPen = getCol('QUANTIDADE PENDENTE', getCol('PENDENTE', src.type === 'SEDE' ? 19 : 13));
            let idxObs = getCol('OBSERVACOES', getCol('OBSERVACAO', 17));

            const parseNum = (val) => {
                if (!val) return 0;
                let clean = val.toString().replace('R$', '').replace(/\./g, '').replace(',', '.');
                return parseFloat(clean) || 0;
            };

            rawData.forEach((row, r) => {
                if (!row[idxProcesso] && !row[idxLocal] && !row[idxMobilia]) return;

                let rawC = (idxTipoReal > -1 && row[idxTipoReal]) ? row[idxTipoReal].toString().trim() : '';
                let valConvenio = (rawC === '' || rawC === '-') ? 'OUTROS' : rawC.toUpperCase();
                let numProcesso = (row[idxProcesso] || '').toString().replace(/\./g, '').trim(); 
                let localVal = (row[idxLocal] || 'Não Identificado').toString().trim();
                let localCheck = localVal.toLowerCase();

                let item = {
                    origem: src.type, processo: numProcesso, link_sei: linkMap[numProcesso] || '',
                    link_planilha: `https://docs.google.com/spreadsheets/d/${src.id}/edit`,
                    local: localVal, tipo: (row[idxTipoReal] || '').toString().trim(), mobilia: (row[idxMobilia] || '').toString().trim(),
                    material: (idxMaterial > -1 ? (row[idxMaterial] || '').toString().trim() : ''), dimensoes: (idxDimensoes > -1 ? (row[idxDimensoes] || '').toString().trim() : ''),
                    status: (row[idxStatus] || '').toString().toUpperCase().trim(), prioridade: row[idxPrio] || '', data_autorizacao: (row[idxDataAut] || '').toString().trim(),
                    data_entrega: (row[idxDataEnt] || '').toString().trim(), previsao: (row[idxPrev] || '').toString().trim(), demandante: (row[idxDem] || '').toString().trim(),
                    beneficiario: (row[idxBen] || '').toString().trim(), convenio: valConvenio, qtd_solicitada: parseNum(row[idxQtdSol]),
                    qtd_entregue: parseNum(row[idxQtdEnt]), qtd_pendente: parseNum(row[idxQtdPen]), observacao: (row[idxObs] !== undefined && row[idxObs] !== null) ? row[idxObs].toString().trim() : ''
                };

                let mobLower = item.mobilia.toLowerCase();
                item.tipo_servico = (mobLower.includes('carteira') || mobLower.includes('cadeira') || mobLower.includes('longarina') || mobLower.includes('conjunto aluno')) ? 'SERRALHERIA' : 'MARCENARIA';

                combinedMarcenaria.push(item);

                if (localCheck.includes('procon') || localCheck.includes('estação tech') || localCheck.includes('estacao tech')) {
                    combinedProcon.push({
                        origem: item.origem, processo: item.processo, link_sei: item.link_sei, link_planilha: item.link_planilha,
                        local: item.local.toUpperCase(), status: item.status, previsao: item.previsao, mobilia: item.mobilia,
                        material: item.material, dimensoes: item.dimensoes, qtd_sol: item.qtd_solicitada,
                        qtd_ent: item.qtd_entregue, qtd_pen: item.qtd_pendente
                    });
                }
            });
        } catch (err) { console.error(`Erro ao processar ${src.type}:`, err); }
    }));

    return { marcenaria: combinedMarcenaria, procon: combinedProcon };
}

// --- ROTAS DO SERVIDOR ---
app.get('/', async (req, res) => {
    try {
        const forceRefresh = req.query.refresh === 'true';
        let data = myCache.get('DASHBOARD_DATA');

        if (!data || forceRefresh) {
            data = await fetchDataFromSheets();
            myCache.set('DASHBOARD_DATA', data);
        }
        res.render('index', { INITIAL_DATA: JSON.stringify(data) });
    } catch (err) {
        res.status(500).send("Erro ao carregar o painel: " + err.message);
    }
});

app.get('/api/data', async (req, res) => {
    try {
        const data = await fetchDataFromSheets();
        myCache.set('DASHBOARD_DATA', data);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- GERAÇÃO DE PDF (Otimizado para Vercel) ---
app.post('/api/pdf', async (req, res) => {
    try {
        const { type, items } = req.body;
        
        let html = ``;

        let title = (type === 3 || type === 4) ? "RELATÓRIO CONSOLIDADO GERAL - MARCENARIA" : "RELATÓRIO DE PROCESSOS - MARCENARIA";
        html += `${title}Data de Emissão: ${new Date().toLocaleString('pt-BR')}`;

        const formatRow = (cols) => {
            let rowHtml = "";
            cols.forEach((c, i) => {
                let clazz = (i >= cols.length - 3) ? "text-center" : "";
                if (i === cols.length - 1 && parseFloat(c) > 0) clazz += " pend-alert";
                rowHtml += `${c}`;
            });
            return rowHtml + "";
        };

        if (type === 1 || type === 2) {
            let grouped = {};
            items.forEach(item => {
                let proc = item.processo || "S/N";
                if (!grouped[proc]) grouped[proc] = { local: item.local, items: [] };
                grouped[proc].items.push(item);
            });

            for (let proc in grouped) {
                let g = grouped[proc];
                html += `PROCESSO: ${proc}  |  LOCAL: ${g.local}`;
                if (type === 1) html += "";
                else html += "";
                html += "";

                if (type === 1) {
                    g.items.forEach(item => {
                        let pend = Math.max(0, (item.qtd_solicitada || 0) - (item.qtd_entregue || 0));
                        html += formatRow([item.mobilia || "-", item.material || "-", item.dimensoes || "-", item.qtd_solicitada || 0, item.qtd_entregue || 0, pend]);
                    });
                } else {
                    let aggProcesso = {};
                    g.items.forEach(item => {
                        let m = (item.mobilia || "-").toUpperCase().trim();
                        if (!aggProcesso[m]) aggProcesso[m] = { sol: 0, ent: 0 };
                        aggProcesso[m].sol += (item.qtd_solicitada || 0);
                        aggProcesso[m].ent += (item.qtd_entregue || 0);
                    });
                    for (let m in aggProcesso) {
                        let pend = Math.max(0, aggProcesso[m].sol - aggProcesso[m].ent);
                        html += formatRow([m, aggProcesso[m].sol, aggProcesso[m].ent, pend]);
                    }
                }
                html += "MobíliaMaterialDimensõesMobília (Agrupada)Sol.Ent.Pend.";
            }
        } else {
            html += "";
            if (type === 3) html += "";
            else html += "";
            html += "";

            let aggGlobal = {};
            items.forEach(item => {
                let key = type === 3 
                    ? `${(item.mobilia||"-").toUpperCase().trim()}|${(item.material||"-").toUpperCase().trim()}|${(item.dimensoes||"-").toUpperCase().trim()}`
                    : (item.mobilia||"-").toUpperCase().trim();
                
                if (!aggGlobal[key]) aggGlobal[key] = { mobilia: item.mobilia||"-", material: item.material||"-", dimensoes: item.dimensoes||"-", sol: 0, ent: 0 };
                aggGlobal[key].sol += (item.qtd_solicitada || 0);
                aggGlobal[key].ent += (item.qtd_entregue || 0);
            });

            Object.keys(aggGlobal).sort().forEach(k => {
                let obj = aggGlobal[k];
                let pend = Math.max(0, obj.sol - obj.ent);
                if (type === 3) html += formatRow([obj.mobilia, obj.material, obj.dimensoes, obj.sol, obj.ent, pend]);
                else html += formatRow([obj.mobilia, obj.sol, obj.ent, pend]);
            });
            html += "MobíliaMaterialDimensõesMobíliaSol.Ent.Pend.";
        }
        html += "";

        // Lança o Chromium leve suportado pelo Vercel
        const browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
        await browser.close();

        let fType = (type <= 2) ? "Processos" : "Consolidado";
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="Marcenaria_${fType}.pdf"`
        });
        res.send(pdfBuffer);
    } catch (e) {
        console.error(e);
        res.status(500).send("Erro na geração do PDF");
    }
});

// Em vez de "app.listen", no Vercel nós EXPORTAMOS o app.
// O listen fica apenas para rodar localmente no seu PC.
if (process.env.NODE_ENV !== 'production') {
    const PORT = 3000;
    app.listen(PORT, () => console.log(`Dashboard rodando em http://localhost:${PORT}`));
}

module.exports = app;