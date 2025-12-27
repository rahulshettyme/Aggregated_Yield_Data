const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

// Helper to read DB
const readDb = () => {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('Error reading DB:', err);
        return { environment_api_urls: {}, environment_urls: {} };
    }
};

// Hardcoded SSO URLs
const QA_TOKEN_BASE = "https://v2sso-gcp.cropin.co.in/auth/realms/";
const PROD_TOKEN_BASE = "https://sso.sg.cropin.in/auth/realms/";

// POST Generate Token for User Aggregate
app.post('/api/user-aggregate/token', async (req, res) => {
    const { environment, tenant, username, password } = req.body;

    if (!environment || !tenant || !username || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    const tokenBase = environment.toLowerCase().startsWith('qa') ? QA_TOKEN_BASE : PROD_TOKEN_BASE;
    const tokenUrl = `${tokenBase}${tenant.toLowerCase()}/protocol/openid-connect/token`;

    console.log(`[User Aggregate] Token URL: ${tokenUrl}`);

    const formData = new URLSearchParams();
    formData.append('grant_type', 'password');
    formData.append('username', username);
    formData.append('password', password);
    formData.append('client_id', 'resource_server');
    formData.append('client_secret', 'resource_server');
    formData.append('scope', 'openid');

    try {
        const urlObj = new URL(tokenUrl);
        const postData = formData.toString();

        const options = {
            hostname: urlObj.hostname,
            port: 443,
            path: urlObj.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const tokenReq = https.request(options, (tokenRes) => {
            let data = '';
            tokenRes.on('data', (chunk) => { data += chunk; });
            tokenRes.on('end', () => {
                try {
                    const jsonData = JSON.parse(data);
                    if (tokenRes.statusCode >= 200 && tokenRes.statusCode < 300) {
                        res.json(jsonData);
                    } else {
                        console.error('[User Aggregate] Token Error:', tokenRes.statusCode, data);
                        res.status(tokenRes.statusCode).json({
                            error: jsonData.error_description || jsonData.error || 'Authentication failed'
                        });
                    }
                } catch (e) {
                    console.error('[User Aggregate] Parse Error:', e);
                    res.status(500).json({ error: 'Failed to parse token response' });
                }
            });
        });

        tokenReq.on('error', (e) => {
            console.error('[User Aggregate] Request Error:', e);
            res.status(500).json({ error: 'Token request failed: ' + e.message });
        });

        tokenReq.write(postData);
        tokenReq.end();

    } catch (err) {
        console.error('[User Aggregate] Error:', err);
        res.status(500).json({ error: 'Internal error generating token' });
    }
});

// GET User-Info
app.get('/api/user-aggregate/user-info', (req, res) => {
    // Placeholder to prevent 404 errors until actual implementation is needed
    // This allows the frontend to proceed without error
    res.json({ success: true, data: { preferences: {} } });
});


// GET User Projects
app.get('/api/user-aggregate/projects', (req, res) => {
    const { environment, tenant } = req.query;
    const authHeader = req.headers.authorization;

    if (!environment || !tenant) return res.status(400).json({ error: 'Missing environment or tenant' });
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing or invalid authorization header' });

    const db = readDb();
    const envApiUrls = db.environment_api_urls || {};
    const envUrls = db.environment_urls || {};

    let apiBaseUrl = null;
    let frontendUrl = null;
    for (const key of Object.keys(envApiUrls)) {
        if (key.toLowerCase() === environment.toLowerCase()) {
            apiBaseUrl = envApiUrls[key];
            break;
        }
    }
    for (const key of Object.keys(envUrls)) {
        if (key.toLowerCase() === environment.toLowerCase()) {
            frontendUrl = envUrls[key];
            break;
        }
    }

    if (!apiBaseUrl) return res.status(400).json({ error: `Unknown environment: ${environment}` });

    const projectsPath = `/services/farm/api/projects?userHierarchyPreference=true&size=5000&projectPreferenceRequired=true&sort=projectStatus,asc&sort=lastModifiedDate,desc`;
    const fullUrl = apiBaseUrl + projectsPath;

    console.log(`[User Aggregate] Projects URL: ${fullUrl}`);

    const makeRequest = (url, redirectCount = 0) => {
        if (redirectCount > 5) return res.status(500).json({ error: 'Too many redirects' });
        const urlObj = new URL(url);
        const headers = {
            'Authorization': authHeader,
            'Accept': 'application/json, text/plain, */*',
            'accept-language': 'en',
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'origin': frontendUrl || apiBaseUrl,
            'referer': (frontendUrl || apiBaseUrl) + '/',
            'X-Requested-With': 'XMLHttpRequest'
        };

        const options = {
            hostname: urlObj.hostname, port: urlObj.port || 443, path: urlObj.pathname + urlObj.search, method: 'GET', headers: headers
        };

        const projectsReq = https.request(options, (projectsRes) => {
            if ([301, 302, 303, 307, 308].includes(projectsRes.statusCode) && projectsRes.headers.location) {
                return makeRequest(new URL(projectsRes.headers.location, url).toString(), redirectCount + 1);
            }
            let data = '';
            projectsRes.on('data', chunk => data += chunk);
            projectsRes.on('end', () => {
                if (data.trim().startsWith('<')) return res.status(502).json({ error: 'API returned HTML' });
                try {
                    const jsonData = JSON.parse(data);
                    if (projectsRes.statusCode >= 200 && projectsRes.statusCode < 300) {
                        let projectsList = Array.isArray(jsonData) ? jsonData : (jsonData.content || []);
                        const projects = projectsList.filter(p => p.projectStatus === 'LIVE').map(p => ({ id: p.id, name: p.name }));
                        res.json({ projects });
                    } else {
                        res.status(projectsRes.statusCode).json({ error: jsonData.message || 'Failed' });
                    }
                } catch (e) {
                    res.status(500).json({ error: 'Parse Error' });
                }
            });
        });
        projectsReq.on('error', e => res.status(500).json({ error: e.message }));
        projectsReq.end();
    };

    try { makeRequest(fullUrl); } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET User Plots for a Project
app.get('/api/user-aggregate/plots', (req, res) => {
    const { environment, projectId } = req.query;
    const authHeader = req.headers.authorization;

    if (!environment || !projectId) return res.status(400).json({ error: 'Missing params' });
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

    const db = readDb();
    const envApiUrls = db.environment_api_urls || {};
    const envUrls = db.environment_urls || {};
    let apiBaseUrl = null;
    let frontendUrl = null;
    for (const key of Object.keys(envApiUrls)) if (key.toLowerCase() === environment.toLowerCase()) { apiBaseUrl = envApiUrls[key]; break; }
    for (const key of Object.keys(envUrls)) if (key.toLowerCase() === environment.toLowerCase()) { frontendUrl = envUrls[key]; break; }

    if (!apiBaseUrl) return res.status(400).json({ error: 'Unknown environment' });

    const fullUrl = apiBaseUrl + `/services/farm/api/dashboard/latlongs?size=5000&projectIds=${projectId}`;
    const urlObj = new URL(fullUrl);
    const postBody = '{}';
    const options = {
        hostname: urlObj.hostname, port: 443, path: urlObj.pathname + urlObj.search, method: 'POST',
        headers: {
            'Authorization': authHeader, 'Accept': 'application/vnd.v2+json', 'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postBody), 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'origin': frontendUrl || 'https://sf-v2.cropin.co.in', 'referer': (frontendUrl || 'https://sf-v2.cropin.co.in') + '/',
            'X-Requested-With': 'XMLHttpRequest'
        }
    };

    const plotsReq = https.request(options, (plotsRes) => {
        let data = '';
        plotsRes.on('data', chunk => data += chunk);
        plotsRes.on('end', () => {
            if (data.trim().startsWith('<')) return res.status(502).json({ error: 'API returned HTML' });
            try {
                const jsonData = JSON.parse(data);
                if (plotsRes.statusCode >= 200 && plotsRes.statusCode < 300) {
                    let plotsList = Array.isArray(jsonData) ? jsonData : (jsonData.content || []);
                    const plots = plotsList.map(p => ({ name: p.name, caId: p.caId }));
                    res.json({ plots, totalCount: plots.length });
                } else {
                    res.status(plotsRes.statusCode).json({ error: jsonData.message || 'Failed' });
                }
            } catch (e) { res.status(500).json({ error: 'Parse Error' }); }
        });
    });
    plotsReq.on('error', e => res.status(500).json({ error: e.message }));
    plotsReq.write(postBody);
    plotsReq.end();
});

// GET CA Details
app.get('/api/user-aggregate/ca-details', (req, res) => {
    const { environment, caId } = req.query;
    const authHeader = req.headers.authorization;
    if (!environment || !caId) return res.status(400).json({ error: 'Missing params' });
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

    const db = readDb();
    const envApiUrls = db.environment_api_urls || {};
    const envUrls = db.environment_urls || {};
    let apiBaseUrl = null;
    let frontendUrl = null;
    for (const key of Object.keys(envApiUrls)) if (key.toLowerCase() === environment.toLowerCase()) { apiBaseUrl = envApiUrls[key]; break; }
    for (const key of Object.keys(envUrls)) if (key.toLowerCase() === environment.toLowerCase()) { frontendUrl = envUrls[key]; break; }

    const fullUrl = apiBaseUrl + `/services/farm/api/croppable-areas/${caId}`;
    const urlObj = new URL(fullUrl);
    const options = {
        hostname: urlObj.hostname, port: 443, path: urlObj.pathname, method: 'GET',
        headers: {
            'Authorization': authHeader, 'Accept': 'application/json', 'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'origin': frontendUrl || apiBaseUrl, 'referer': (frontendUrl || apiBaseUrl) + '/'
        }
    };

    https.request(options, (caRes) => {
        let data = '';
        caRes.on('data', chunk => data += chunk);
        caRes.on('end', () => {
            if (data.trim().startsWith('<')) return res.status(502).json({ error: 'API returned HTML' });
            try {
                const jsonData = JSON.parse(data);
                if (caRes.statusCode >= 200 && caRes.statusCode < 300) {
                    const auditedAreaValue = jsonData.auditedArea?.count || jsonData.auditedArea || 0;
                    res.json({
                        caId: caId, auditedArea: auditedAreaValue, expectedQuantity: jsonData.expectedQuantity,
                        reestimatedValue: jsonData.reestimatedValue, expectedYield: jsonData.data?.expectedYield,
                        reEstimatedHarvest: jsonData.reestimatedValue
                    });
                } else { res.status(caRes.statusCode).json({ error: jsonData.message }); }
            } catch (e) { res.status(500).json({ error: 'Parse Error' }); }
        });
    }).on('error', e => res.status(500).json({ error: e.message })).end();
});

// GET Yield Prediction
app.get('/api/user-aggregate/yield-prediction', (req, res) => {
    const { environment, caIds } = req.query;
    const authHeader = req.headers.authorization;
    if (!environment || !caIds) return res.status(400).json({ error: 'Missing params' });
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

    const db = readDb();
    const envApiUrls = db.environment_api_urls || {};
    const envUrls = db.environment_urls || {};
    let apiBaseUrl = null;
    let frontendUrl = null;
    for (const key of Object.keys(envApiUrls)) if (key.toLowerCase() === environment.toLowerCase()) { apiBaseUrl = envApiUrls[key]; break; }
    for (const key of Object.keys(envUrls)) if (key.toLowerCase() === environment.toLowerCase()) { frontendUrl = envUrls[key]; break; }

    const fullUrl = apiBaseUrl + `/services/farm/api/plot-risk/yield?caIds=${caIds}`;
    const urlObj = new URL(fullUrl);
    const options = {
        hostname: urlObj.hostname, port: 443, path: urlObj.pathname + urlObj.search, method: 'GET',
        headers: {
            'Authorization': authHeader, 'Accept': 'application/json', 'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'origin': frontendUrl || apiBaseUrl, 'referer': (frontendUrl || apiBaseUrl) + '/'
        }
    };

    https.request(options, (yieldRes) => {
        let data = '';
        yieldRes.on('data', chunk => data += chunk);
        yieldRes.on('end', () => {
            if (data.trim().startsWith('<')) return res.status(502).json({ error: 'API returned HTML' });
            try {
                const jsonData = JSON.parse(data);
                if (yieldRes.statusCode >= 200 && yieldRes.statusCode < 300) {
                    let params = {};
                    if (jsonData.records?.length > 0) params = jsonData.records[0].parameters || {};
                    else if (jsonData.parameters) params = jsonData.parameters;

                    const parseVal = (v) => parseFloat(v) || 'NA';
                    res.json({
                        caId: caIds,
                        productionMin: parseVal(params.productionMin), productionMax: parseVal(params.productionMax),
                        productionAvg: parseVal(params.productionAvg), yieldMin: parseVal(params.yieldMin),
                        yieldMax: parseVal(params.yieldMax), yieldAvg: parseVal(params.yieldAvg)
                    });
                } else { res.status(yieldRes.statusCode).json({ error: jsonData.message }); }
            } catch (e) { res.status(500).json({ error: 'Parse Error' }); }
        });
    }).on('error', e => res.status(500).json({ error: e.message })).end();
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
