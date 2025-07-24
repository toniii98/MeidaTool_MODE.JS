// Importowanie niezbędnych modułów
const express = require('express');
const dotenv = require('dotenv');
const path = require('path');

// Ładowanie zmiennych środowiskowych
dotenv.config();

// Importowanie naszego serwisu AWS
const { 
    listChannels, 
    listInputs, 
    getAvailableRegions,
    listS3Mp4Assets,
    listInputDevices,
    listInputSecurityGroups,
    listMediaConnectFlows,
    listMediaPackageChannels,
    createRtmpInput,
    createMp4Input,
    createChannel,
    createLinkInput,
    createMediaConnectInput,
    startChannel,
    stopChannel,
    deleteChannel,
    deleteInput
} = require('./services/awsService');

// Inicjalizacja aplikacji Express
const app = express();
const port = process.env.PORT || 3000;

// Ustawienia aplikacji
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Definicja Tras (Routes) ---

// Główna trasa GET
app.get('/', async (req, res) => {
  let channels = [];
  let inputs = [];
  let availableRegions = [];
  let linkDevices = [];
  let inputSecurityGroups = [];
  let mediaConnectFlows = [];
  let mediaPackageChannels = [];
  const { message, messageStatus } = req.query;
  let error = null; 
  const currentRegion = req.query.region || process.env.AWS_REGION;
  
  if (!currentRegion) {
     error = "Region AWS nie został określony. Wybierz region z listy lub ustaw AWS_REGION w pliku .env.";
     return res.render('index', {
        pageTitle: 'Błąd Konfiguracji',
        error, channels, inputs, availableRegions: [], linkDevices, inputSecurityGroups, mediaConnectFlows, mediaPackageChannels, currentRegion: '', message, messageStatus
     });
  }

  try {
    const [channelsResponse, inputsResponse, regionsResponse, devicesResponse, securityGroupsResponse, flowsResponse, mpChannelsResponse] = await Promise.all([
      listChannels(currentRegion),
      listInputs(currentRegion),
      getAvailableRegions(),
      listInputDevices(currentRegion),
      listInputSecurityGroups(currentRegion),
      listMediaConnectFlows(currentRegion),
      listMediaPackageChannels(currentRegion)
    ]);
    channels = channelsResponse;
    inputs = inputsResponse;
    availableRegions = regionsResponse;
    linkDevices = devicesResponse;
    inputSecurityGroups = securityGroupsResponse;
    mediaConnectFlows = flowsResponse;
    mediaPackageChannels = mpChannelsResponse;
  } catch (err) {
    console.error("Failed to fetch AWS resources:", err);
    error = `Nie udało się pobrać zasobów z AWS dla regionu ${currentRegion}. Sprawdź konsolę serwera i plik .env.`;
    try {
        if (availableRegions.length === 0) availableRegions = await getAvailableRegions();
    } catch (regionErr) {
        console.error("Failed to fetch available regions as well:", regionErr);
    }
  }

  res.render('index', {
    pageTitle: 'Dashboard',
    channels,
    inputs,
    error,
    availableRegions,
    linkDevices,
    inputSecurityGroups,
    mediaConnectFlows,
    mediaPackageChannels,
    currentRegion,
    message,
    messageStatus
  });
});

// Trasy API
app.get('/api/s3-assets', async (req, res) => {
    const { region } = req.query;
    if (!region) return res.status(400).json({ error: "Region not specified." });
    try {
        const assets = await listS3Mp4Assets(region);
        res.json(assets);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Trasy POST do tworzenia
app.post('/inputs/create-rtmp', async (req, res) => {
    const { inputName, inputClass, securityGroupId, region } = req.body;
    try {
        await createRtmpInput(region, inputName, inputClass, securityGroupId);
        res.redirect(`/?region=${region}&message=Input RTMP '${inputName}' został pomyślnie utworzony.&messageStatus=success`);
    } catch (error) {
        res.redirect(`/?region=${region}&message=Błąd podczas tworzenia inputu: ${error.message}&messageStatus=danger`);
    }
});

app.post('/inputs/create-mp4', async (req, res) => {
    const { inputName, inputClass, s3FilePath, region } = req.body;
    const bucketName = process.env.S3_ASSET_BUCKET;
    const urls = [`s3://${bucketName}/${s3FilePath}`];
    // Jeśli wybrano klasę STANDARD, AWS wymaga dwóch identycznych URLi
    if (inputClass === 'STANDARD') {
        urls.push(`s3://${bucketName}/${s3FilePath}`);
    }
    try {
        await createMp4Input(region, inputName, urls);
        res.redirect(`/?region=${region}&message=Input MP4 '${inputName}' został pomyślnie utworzony.&messageStatus=success`);
    } catch (error) {
        res.redirect(`/?region=${region}&message=Błąd podczas tworzenia inputu MP4: ${error.message}&messageStatus=danger`);
    }
});

app.post('/channels/create', async (req, res) => {
    const { region } = req.body; 
    try {
        await createChannel(region, req.body);
        res.redirect(`/?region=${region}&message=Kanał '${req.body.channelName}' został pomyślnie utworzony.&messageStatus=success`);
    } catch (error) {
        res.redirect(`/?region=${region}&message=Błąd podczas tworzenia kanału: ${error.message}&messageStatus=danger`);
    }
});

app.post('/inputs/create-link', async (req, res) => {
    const { inputName, linkDeviceId1, linkDeviceId2, region } = req.body;
    const deviceIds = [linkDeviceId1];
    if (linkDeviceId2) {
        deviceIds.push(linkDeviceId2);
    }
    try {
        await createLinkInput(region, inputName, deviceIds);
        res.redirect(`/?region=${region}&message=Input Link '${inputName}' został pomyślnie utworzony.&messageStatus=success`);
    } catch (error) {
        res.redirect(`/?region=${region}&message=Błąd podczas tworzenia inputu Link: ${error.message}&messageStatus=danger`);
    }
});

app.post('/inputs/create-mediaconnect', async (req, res) => {
    const { inputName, flowArn1, flowArn2, region } = req.body;
    const flowArns = [flowArn1];
    if (flowArn2) {
        flowArns.push(flowArn2);
    }
    try {
        await createMediaConnectInput(region, inputName, flowArns);
        res.redirect(`/?region=${region}&message=Input MediaConnect '${inputName}' został pomyślnie utworzony.&messageStatus=success`);
    } catch (error) {
        res.redirect(`/?region=${region}&message=Błąd podczas tworzenia inputu MediaConnect: ${error.message}&messageStatus=danger`);
    }
});

// Trasy POST do zarządzania i usuwania
app.post('/channels/start', async (req, res) => {
    const { channelId, region } = req.body;
    try {
        await startChannel(region, channelId);
        res.redirect(`/?region=${region}&message=Wysłano polecenie uruchomienia kanału ${channelId}.&messageStatus=success`);
    } catch (error) {
        res.redirect(`/?region=${region}&message=Błąd podczas uruchamiania kanału: ${error.message}&messageStatus=danger`);
    }
});

app.post('/channels/stop', async (req, res) => {
    const { channelId, region } = req.body;
    try {
        await stopChannel(region, channelId);
        res.redirect(`/?region=${region}&message=Wysłano polecenie zatrzymania kanału ${channelId}.&messageStatus=success`);
    } catch (error) {
        res.redirect(`/?region=${region}&message=Błąd podczas zatrzymywania kanału: ${error.message}&messageStatus=danger`);
    }
});

app.post('/channels/delete', async (req, res) => {
    const { channelId, region } = req.body;
    try {
        await deleteChannel(region, channelId);
        res.redirect(`/?region=${region}&message=Kanał ${channelId} został usunięty.&messageStatus=success`);
    } catch (error) {
        res.redirect(`/?region=${region}&message=Błąd podczas usuwania kanału: ${error.message}&messageStatus=danger`);
    }
});

app.post('/inputs/delete', async (req, res) => {
    const { inputId, region } = req.body;
    try {
        await deleteInput(region, inputId);
        res.redirect(`/?region=${region}&message=Input ${inputId} został usunięty.&messageStatus=success`);
    } catch (error) {
        res.redirect(`/?region=${region}&message=Błąd podczas usuwania inputu: ${error.message}&messageStatus=danger`);
    }
});

// --- Uruchomienie serwera ---
app.listen(port, () => {
  console.log(`Serwer uruchomiony na porcie ${port}`);
  console.log(`Otwórz w przeglądarce: http://localhost:${port}`);
});
