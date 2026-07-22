const express = require('express');
const { google } = require('googleapis');
const NodeCache = require('node-cache');
const path = require('path'); // Mantido para resolver o caminho no Vercel

const app = express();
app.use(express.json({ limit: '50mb' }));

// Define o caminho absoluto para as views
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const myCache = new NodeCache({ stdTTL: 600 });

// --- AUTENTICAÇÃO ANTI-CRASH PARA O VERCEL ---
let auth;
let sheets;
try {
    if (process.env.GOOGLE_CREDENTIALS) {
        // Corrige o bug do Vercel que bagunça as quebras de linha do JSON
        const cleanJson = process.env.GOOGLE_CREDENTIALS.replace(/\\n/g, '\n');
        auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(cleanJson),
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
        });
    } else {
        auth = new google.auth.GoogleAuth({
            keyFile: 'credentials.json',
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
        });
    }
    sheets = google.sheets({ version: 'v4', auth });
} catch (error) {
    console.error("ERRO CRÍTICO NA LEITURA DA CHAVE DO GOOGLE:", error.message);
}

// --- LÓGICA DE BUSCA DE DADOS ---
async function fetchDataFromSheets() {
    if (!sheets) throw new Error("API do Google não inicializada. Verifique as credenciais.");

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
                    origem: src.type,
                    processo: numProcesso,
                    link_sei: linkMap[numProcesso] || '',
                    link_planilha: `https://docs.google.com/spreadsheets/d/${src.id}/edit`,
                    local: localVal,
                    tipo: (row[idxTipoReal] || '').toString().trim(),
                    mobilia: (row[idxMobilia] || '').toString().trim(),
                    material: (idxMaterial > -1 ? (row[idxMaterial] || '').toString().trim() : ''),
                    dimensoes: (idxDimensoes > -1 ? (row[idxDimensoes] || '').toString().trim() : ''),
                    status: (row[idxStatus] || '').toString().toUpperCase().trim(),
                    prioridade: row[idxPrio] || '',
                    data_autorizacao: (row[idxDataAut] || '').toString().trim(),
                    data_entrega: (row[idxDataEnt] || '').toString().trim(),
                    previsao: (row[idxPrev] || '').toString().trim(),
                    demandante: (row[idxDem] || '').toString().trim(),
                    beneficiario: (row[idxBen] || '').toString().trim(),
                    convenio: valConvenio,
                    qtd_solicitada: parseNum(row[idxQtdSol]),
                    qtd_entregue: parseNum(row[idxQtdEnt]),
                    qtd_pendente: parseNum(row[idxQtdPen]),
                    observacao: (row[idxObs] !== undefined && row[idxObs] !== null) ? row[idxObs].toString().trim() : ''
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
            console.log("Buscando dados no Google Sheets...");
            data = await fetchDataFromSheets();
            myCache.set('DASHBOARD_DATA', data);
        }
        res.render('index', { INITIAL_DATA: JSON.stringify(data) });
    } catch (err) {
        console.error("Erro no GET /:", err);
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

// --- GERAÇÃO DE PDF (COM IMPORTAÇÃO DINÂMICA) ---
app.post('/api/pdf', async (req, res) => {
    try {
        const { type, items } = req.body;
        
        let html = `<!DOCTYPE html><html lang='pt-BR'><head><style>
            body { font-family: 'Helvetica', 'Arial', sans-serif; font-size: 11px; color: #333; }
            h2 { text-align: center; color: #3e2723; margin-bottom: 5px; font-size: 16px; text-transform: uppercase; }
            .header-info { text-align: center; font-size: 10px; color: #777; margin-bottom: 20px; }
            .processo-box { margin-bottom: 15px; border: 1px solid #d7ccc8; border-radius: 6px; padding: 10px; page-break-inside: avoid; background-color: #fafafa; }
            .proc-title { font-size: 11px; font-weight: bold; color: #3e2723; margin-bottom: 8px; border-bottom: 1px solid #ddd; padding-bottom: 5px; text-transform: uppercase; }
            table { width: 100%; border-collapse: collapse; margin-top: 5px; }
            th, td { border-bottom: 1px solid #e0e0e0; padding: 6px 4px; text-align: left; font-size: 10px; }
            th { color: #5d4037; font-weight: bold; background-color: #fff; text-transform: uppercase; font-size: 9px;}
            .text-center { text-align: center; }
            .pend-alert { color: #d32f2f; font-weight: bold; }
        </style></head><body>`;

        let title = (type === 3 || type === 4) ? "RELATÓRIO CONSOLIDADO GERAL - MARCENARIA" : "RELATÓRIO DE PROCESSOS - MARCENARIA";
        html += `<h2>${title}</h2><div class='header-info'>Data de Emissão: ${new Date().toLocaleString('pt-BR')}</div>`;

        const formatRow = (cols) => {
            let rowHtml = "<tr>";
            cols.forEach((c, i) => {
                let clazz = (i >= cols.length - 3) ? "text-center" : "";
                if (i === cols.length - 1 && parseFloat(c) > 0) clazz += " pend-alert";
                rowHtml += `<td class='${clazz}'>${c}</td>`;
            });
            return rowHtml + "</tr>";
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
                html += `<div class='processo-box'><div class='proc-title'>PROCESSO: ${proc} &nbsp;|&nbsp; LOCAL: ${g.local}</div><table><thead><tr>`;
                if (type === 1) html += "<th width='35%'>Mobília</th><th width='20%'>Material</th><th width='15%'>Dimensões</th>";
                else html += "<th width='70%'>Mobília (Agrupada)</th>";
                html += "<th width='10%' class='text-center'>Sol.</th><th width='10%' class='text-center'>Ent.</th><th width='10%' class='text-center'>Pend.</th></tr></thead><tbody>";

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
                html += "</tbody></table></div>";
            }
        } else {
            html += "<table><thead><tr>";
            if (type === 3) html += "<th width='35%'>Mobília</th><th width='20%'>Material</th><th width='15%'>Dimensões</th>";
            else html += "<th width='70%'>Mobília</th>";
            html += "<th width='10%' class='text-center'>Sol.</th><th width='10%' class='text-center'>Ent.</th><th width='10%' class='text-center'>Pend.</th></tr></thead><tbody>";

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
            html += "</tbody></table>";
        }
        html += "</body></html>";

        // Importação Dinâmica DUPLA (Resolve o erro ERR_REQUIRE_ESM do Vercel)
        const puppeteerModule = await import('puppeteer-core');
        const puppeteer = puppeteerModule.default || puppeteerModule;

        const chromiumModule = await import('@sparticuz/chromium');
        const chromium = chromiumModule.default || chromiumModule;

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

// Apenas escuta na porta 3000 se NÃO estiver no Vercel
if (!process.env.VERCEL) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Dashboard rodando localmente na porta ${PORT}`));
}

// Exportação obrigatória para o Vercel Serverless
module.exports = app;