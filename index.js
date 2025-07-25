// Importowanie niezbędnych modułów
const express = require('express');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs').promises;

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
    deleteInput,
    generateResourceNames,
    describeChannel,
    describeInput
} = require('./services/awsService');

// Inicjalizacja aplikacji Express
const app = express();
const port = process.env.PORT || 3000;
const EVENTS_FILE_PATH = path.join(__dirname, 'events.json');

// Ustawienia aplikacji
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Funkcje pomocnicze ---
async function readEventsFile() {
    try {
        const data = await fs.readFile(EVENTS_FILE_PATH, 'utf8');
        if (data.trim() === '') {
            return { events: {} };
        }
        const parsedData = JSON.parse(data);
        if (typeof parsedData !== 'object' || parsedData === null || !parsedData.hasOwnProperty('events') || typeof parsedData.events !== 'object' || Array.isArray(parsedData.events)) {
             console.warn('Nieprawidłowa struktura events.json, resetowanie do domyślnej.');
             await writeEventsFile({ events: {} });
             return { events: {} }; 
        }
        return parsedData;
    } catch (error) {
        if (error.code === 'ENOENT') {
            await writeEventsFile({ events: {} });
            return { events: {} };
        }
        if (error instanceof SyntaxError) {
            console.error("Błąd parsowania pliku events.json. Plik jest prawdopodobnie uszkodzony. Resetowanie do pustej struktury.", error);
            await writeEventsFile({ events: {} });
            return { events: {} };
        }
        console.error("Błąd odczytu pliku events.json:", error);
        throw error;
    }
}

async function writeEventsFile(data) {
    await fs.writeFile(EVENTS_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// NOWA FUNKCJA: Synchronizacja pliku events.json z rzeczywistym stanem w AWS
async function synchronizeEventsWithAWS(region) {
    console.log(`Rozpoczynanie synchronizacji eventów dla regionu: ${region}`);
    try {
        const eventsData = await readEventsFile();
        const awsChannels = await listChannels(region);

        const awsChannelIds = new Set(awsChannels.map(c => c.Id));
        let changesMade = false;

        for (const channelId in eventsData.events) {
            if (eventsData.events[channelId].region === region && !awsChannelIds.has(channelId)) {
                console.log(`Event ${eventsData.events[channelId].eventName} (ID: ${channelId}) nie ma odpowiadającego kanału w AWS. Usuwanie...`);
                delete eventsData.events[channelId];
                changesMade = true;
            }
        }

        if (changesMade) {
            console.log("Zapisywanie zmian w events.json po synchronizacji.");
            await writeEventsFile(eventsData);
        } else {
            console.log("Synchronizacja zakończona, brak zmian.");
        }
    } catch (error) {
        console.error("Błąd podczas synchronizacji eventów z AWS:", error);
    }
}


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
    // Synchronizuj eventy przed załadowaniem danych
    await synchronizeEventsWithAWS(currentRegion);

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

// Trasy API dla eventów
app.get('/api/events', async (req, res) => {
    try {
        const events = await readEventsFile();
        res.json(events);
    } catch (error) {
        console.error('Error reading events file:', error);
        res.status(500).json({ error: 'Failed to read events data' });
    }
});

app.get('/api/events/:channelId', async (req, res) => {
    try {
        const { channelId } = req.params;
        const eventsData = await readEventsFile();
        const event = eventsData.events[channelId];

        if (!event) {
            return res.status(404).json({ error: 'Event not found in events.json. It might have been deleted.' });
        }

        let channelDetails;
        const maxRetries = 5;
        const retryDelay = 2000; // 2 sekundy

        for (let i = 0; i < maxRetries; i++) {
            try {
                channelDetails = await describeChannel(event.region, event.channelId);
                break; // Sukces, wyjdź z pętli
            } catch (awsError) {
                if (awsError.name === 'NotFoundException' && i < maxRetries - 1) {
                    console.log(`Kanał ${event.channelId} nie jest jeszcze gotowy. Próba ${i + 1}/${maxRetries}. Ponawianie za ${retryDelay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                } else {
                    console.error(`AWS Error describing channel ${event.channelId}:`, awsError);
                    throw new Error(`Nie udało się pobrać szczegółów kanału z AWS. Sprawdź, czy zasób istnieje w regionie ${event.region}.`);
                }
            }
        }
        
        let inputDetails;
        try {
            inputDetails = await Promise.all(
                event.inputIds.map(id => describeInput(event.region, id))
            );
        } catch (awsError) {
            console.error(`AWS Error describing inputs for channel ${event.channelId}:`, awsError);
            throw new Error(`Nie udało się pobrać szczegółów inputu z AWS.`);
        }

        const inputNames = inputDetails.map(input => input.Name || input.Id);

        const fullEventDetails = {
            ...event,
            pipelineDetails: channelDetails.PipelineDetails || [],
            inputNames: inputNames,
            outputNames: event.outputIds
        };
        
        res.json(fullEventDetails);

    } catch (error) {
        console.error('Error in /api/events/:channelId handler:', error);
        res.status(500).json({ error: error.message || 'Wystąpił wewnętrzny błąd serwera.' });
    }
});


app.post('/api/events/create', async (req, res) => {
    const { 
        eventName, 
        lifetimeStart, 
        region,
        channelClass,
        inputType,
        outputId,
        sourceId,
        sourceId1,
        sourceId2,
    } = req.body;
    
    if (!eventName || !lifetimeStart || !region || !channelClass || !inputType || !outputId) {
        return res.status(400).json({ error: 'Brak wszystkich wymaganych pól.' });
    }

    try {
        const resourceNames = generateResourceNames(eventName);
        let inputResponse;

        switch (inputType) {
            case 'RTMP_PUSH': {
                const securityGroups = await listInputSecurityGroups(region);
                if (!securityGroups || securityGroups.length === 0) {
                    throw new Error('Brak dostępnych grup bezpieczeństwa w tym regionie.');
                }
                const securityGroupId = securityGroups[0].Id;
                inputResponse = await createRtmpInput(region, resourceNames.inputName, channelClass, securityGroupId);
                break;
            }
            case 'MP4_FILE': {
                if (!sourceId) throw new Error('Brak ścieżki do pliku S3 (sourceId).');
                const bucketName = process.env.S3_ASSET_BUCKET;
                const urls = [`s3://${bucketName}/${sourceId}`];
                if (channelClass === 'STANDARD') {
                    urls.push(`s3://${bucketName}/${sourceId}`);
                }
                inputResponse = await createMp4Input(region, resourceNames.inputName, urls);
                break;
            }
            case 'INPUT_DEVICE': { 
                if (!sourceId1) throw new Error('Brak ID urządzenia Link dla pipeline 0 (sourceId1).');
                const deviceIds = [sourceId1];
                if (channelClass === 'STANDARD') {
                    if (!sourceId2) throw new Error('Brak ID urządzenia Link dla pipeline 1 (sourceId2) w trybie Standard.');
                    deviceIds.push(sourceId2);
                }
                inputResponse = await createLinkInput(region, resourceNames.inputName, deviceIds);
                break;
            }
            case 'MEDIACONNECT': {
                if (!sourceId1) throw new Error('Brak ARN dla MediaConnect Flow dla pipeline 0 (sourceId1).');
                const flowArns = [sourceId1];
                if (channelClass === 'STANDARD') {
                    if (!sourceId2) throw new Error('Brak ARN dla MediaConnect Flow dla pipeline 1 (sourceId2) w trybie Standard.');
                    flowArns.push(sourceId2);
                }
                inputResponse = await createMediaConnectInput(region, resourceNames.inputName, flowArns);
                break;
            }
            default:
                throw new Error(`Nieobsługiwany typ inputu: ${inputType}`);
        }

        const inputId = inputResponse.Input.Id;
        
        const channelData = {
            channelName: resourceNames.channelName,
            inputId: inputId,
            channelClass: channelClass,
            mediaPackageChannelId: outputId
        };
        const channelResponse = await createChannel(region, channelData);
        const channelId = channelResponse.Channel.Id;
        
        const eventStartDate = new Date(lifetimeStart);
        const bookingStartDate = new Date(eventStartDate);
        bookingStartDate.setDate(eventStartDate.getDate() - 7);
        const bookingEndDate = new Date(eventStartDate);
        bookingEndDate.setDate(eventStartDate.getDate() + 14);
        
        const eventsData = await readEventsFile();
        
        eventsData.events[channelId] = {
            eventName: eventName,
            channelId: channelId,
            inputIds: [inputId],
            outputIds: [outputId],
            lifetime: {
                start: eventStartDate.toISOString()
            },
            booking: {
                start: bookingStartDate.toISOString().split('T')[0],
                end: bookingEndDate.toISOString().split('T')[0]
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            scheduler: [],
            region: region,
            channelClass: channelClass,
            inputType: inputType
        };
        
        await writeEventsFile(eventsData);
        
        res.status(201).json({ 
            success: true, 
            event: eventsData.events[channelId],
            message: `Event "${eventName}" został pomyślnie utworzony`
        });
        
    } catch (error) {
        console.error('Error creating event:', error);
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/events/:channelId/update', async (req, res) => {
    const { channelId } = req.params;
    const { eventName, lifetimeStart } = req.body;
    
    try {
        const eventsData = await readEventsFile();
        
        if (!eventsData.events[channelId]) {
            return res.status(404).json({ error: 'Event not found' });
        }
        
        if (eventName) {
            eventsData.events[channelId].eventName = eventName;
        }
        if (lifetimeStart) {
            const eventStartDate = new Date(lifetimeStart);
            const bookingStartDate = new Date(eventStartDate);
            bookingStartDate.setDate(eventStartDate.getDate() - 7);
            const bookingEndDate = new Date(eventStartDate);
            bookingEndDate.setDate(eventStartDate.getDate() + 14);

            eventsData.events[channelId].lifetime.start = eventStartDate.toISOString();
            eventsData.events[channelId].booking.start = bookingStartDate.toISOString().split('T')[0];
            eventsData.events[channelId].booking.end = bookingEndDate.toISOString().split('T')[0];
        }
        eventsData.events[channelId].updatedAt = new Date().toISOString();
        
        await writeEventsFile(eventsData);
        
        res.json({ 
            success: true, 
            event: eventsData.events[channelId],
            message: 'Event został zaktualizowany'
        });
        
    } catch (error) {
        console.error('Error updating event:', error);
        res.status(500).json({ error: error.message });
    }
});

// Trasy API dla S3
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
    const { channelId, region: currentRegion } = req.body;
    try {
        const eventsData = await readEventsFile();
        const event = eventsData.events[channelId];
        const eventRegion = event ? event.region : currentRegion;
        await startChannel(eventRegion, channelId);
        res.redirect(`/?region=${currentRegion}&message=Wysłano polecenie uruchomienia kanału ${channelId}.&messageStatus=success`);
    } catch (error) {
        res.redirect(`/?region=${currentRegion}&message=Błąd podczas uruchamiania kanału: ${error.message}&messageStatus=danger`);
    }
});

app.post('/channels/stop', async (req, res) => {
    const { channelId, region: currentRegion } = req.body;
    try {
        const eventsData = await readEventsFile();
        const event = eventsData.events[channelId];
        const eventRegion = event ? event.region : currentRegion;
        await stopChannel(eventRegion, channelId);
        res.redirect(`/?region=${currentRegion}&message=Wysłano polecenie zatrzymania kanału ${channelId}.&messageStatus=success`);
    } catch (error) {
        res.redirect(`/?region=${currentRegion}&message=Błąd podczas zatrzymywania kanału: ${error.message}&messageStatus=danger`);
    }
});

// ZAKTUALIZOWANA LOGIKA USUWANIA
app.post('/channels/delete', async (req, res) => {
    const { channelId, region: currentRegion } = req.body;
    try {
        const eventsData = await readEventsFile();
        const eventToDelete = eventsData.events[channelId];
        const eventRegion = eventToDelete ? eventToDelete.region : currentRegion;

        await deleteChannel(eventRegion, channelId);

        if (eventToDelete && eventToDelete.inputIds) {
            for (const inputId of eventToDelete.inputIds) {
                try {
                    console.log(`Usuwanie powiązanego inputu ${inputId} dla kanału ${channelId}`);
                    await deleteInput(eventRegion, inputId);
                } catch (inputError) {
                    console.error(`Nie udało się usunąć inputu ${inputId}:`, inputError.message);
                }
            }
        }
        
        if (eventsData.events[channelId]) {
            delete eventsData.events[channelId];
            await writeEventsFile(eventsData);
        }

        res.redirect(`/?region=${currentRegion}&message=Kanał ${channelId} i powiązane zasoby zostały usunięte.&messageStatus=success`);
    } catch (error) {
        res.redirect(`/?region=${currentRegion}&message=Błąd podczas usuwania kanału: ${error.message}&messageStatus=danger`);
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
