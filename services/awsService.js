// Importowanie niezbędnych klas z pakietów AWS SDK
const { 
    MediaLiveClient, 
    ListChannelsCommand, 
    ListInputsCommand,
    CreateInputCommand,
    CreateChannelCommand,
    StartChannelCommand,
    StopChannelCommand,
    DeleteChannelCommand,
    DeleteInputCommand,
    ListInputDevicesCommand,
    ListInputSecurityGroupsCommand,
    DescribeChannelCommand, // Nowy import
    DescribeInputCommand    // Nowy import
} = require("@aws-sdk/client-medialive");
const { MediaConnectClient, ListFlowsCommand } = require("@aws-sdk/client-mediaconnect");
const { MediaPackageClient, ListChannelsCommand: ListMPChannelsCommand } = require("@aws-sdk/client-mediapackage");
const { EC2Client, DescribeRegionsCommand } = require("@aws-sdk/client-ec2");
const { STSClient, GetCallerIdentityCommand } = require("@aws-sdk/client-sts");
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const fs = require('fs/promises');
const path = require('path');

// --- Funkcje pomocnicze i listujące ---
function getCredentials() {
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
        throw new Error("Poświadczenia AWS (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) nie są ustawione w pliku .env");
    }
    return {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    };
}

// Funkcja generująca spójne nazwy dla zasobów AWS na podstawie nazwy eventu
function generateResourceNames(eventName) {
    const baseName = eventName
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .substring(0, 40);
    
    return {
        channelName: `${baseName}_channel`,
        inputName: `${baseName}_input`,
        outputName: `${baseName}_output`
    };
}

async function getAvailableRegions() {
    const credentials = getCredentials();
    const ec2Client = new EC2Client({ credentials, region: "us-east-1" });
    try {
        const command = new DescribeRegionsCommand({});
        const response = await ec2Client.send(command);
        return response.Regions ? response.Regions.map(r => r.RegionName).sort() : [];
    } catch (error) {
        console.error("Error fetching available regions:", error);
        throw error;
    }
}

async function listChannels(region) {
    const credentials = getCredentials();
    const mediaLiveClient = new MediaLiveClient({ region, credentials });
    try {
        const command = new ListChannelsCommand({});
        const response = await mediaLiveClient.send(command);
        return response.Channels || [];
    } catch (error) {
        console.error(`Error listing MediaLive channels in ${region}:`, error);
        throw error;
    }
}

async function listInputs(region) {
    const credentials = getCredentials();
    const mediaLiveClient = new MediaLiveClient({ region, credentials });
    try {
        const command = new ListInputsCommand({});
        const response = await mediaLiveClient.send(command);
        return response.Inputs || [];
    } catch (error) {
        console.error(`Error listing MediaLive inputs in ${region}:`, error);
        throw error;
    }
}

async function listS3Mp4Assets(region) {
    const credentials = getCredentials();
    const s3Client = new S3Client({ region, credentials });
    const bucketName = process.env.S3_ASSET_BUCKET;
    const prefix = process.env.S3_ASSET_PREFIX || '';
    if (!bucketName) {
        throw new Error("S3_ASSET_BUCKET nie jest ustawiony w pliku .env");
    }
    try {
        const command = new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix });
        const response = await s3Client.send(command);
        return response.Contents ? response.Contents.map(item => item.Key).filter(key => key.toLowerCase().endsWith('.mp4') && key !== prefix) : [];
    } catch (error) {
        console.error("Error listing S3 assets:", error);
        throw error;
    }
}

async function listInputDevices(region) {
    const credentials = getCredentials();
    const mediaLiveClient = new MediaLiveClient({ region, credentials });
    try {
        const command = new ListInputDevicesCommand({});
        const response = await mediaLiveClient.send(command);
        return response.InputDevices || [];
    } catch (error) {
        console.error(`Error listing input devices in ${region}:`, error);
        throw error;
    }
}

async function listInputSecurityGroups(region) {
    const credentials = getCredentials();
    const mediaLiveClient = new MediaLiveClient({ region, credentials });
    try {
        const command = new ListInputSecurityGroupsCommand({});
        const response = await mediaLiveClient.send(command);
        return response.InputSecurityGroups || [];
    } catch (error) {
        console.error(`Error listing input security groups in ${region}:`, error);
        throw error;
    }
}

async function listMediaConnectFlows(region) {
    const credentials = getCredentials();
    const mediaConnectClient = new MediaConnectClient({ region, credentials });
    try {
        const command = new ListFlowsCommand({});
        const response = await mediaConnectClient.send(command);
        return response.Flows || [];
    } catch (error) {
        console.error(`Error listing MediaConnect flows in ${region}:`, error);
        throw error;
    }
}

async function listMediaPackageChannels(region) {
    const credentials = getCredentials();
    const mediaPackageClient = new MediaPackageClient({ region, credentials });
    try {
        const command = new ListMPChannelsCommand({});
        const response = await mediaPackageClient.send(command);
        return response.Channels || [];
    } catch (error) {
        console.error(`Error listing MediaPackage channels in ${region}:`, error);
        throw error;
    }
}

// --- Funkcje opisujące zasoby (Describe) ---
async function describeChannel(region, channelId) {
    const credentials = getCredentials();
    const mediaLiveClient = new MediaLiveClient({ region, credentials });
    try {
        const command = new DescribeChannelCommand({ ChannelId: channelId });
        return await mediaLiveClient.send(command);
    } catch (error) {
        console.error(`Error describing channel ${channelId}:`, error);
        throw error;
    }
}

async function describeInput(region, inputId) {
    const credentials = getCredentials();
    const mediaLiveClient = new MediaLiveClient({ region, credentials });
    try {
        const command = new DescribeInputCommand({ InputId: inputId });
        return await mediaLiveClient.send(command);
    } catch (error) {
        console.error(`Error describing input ${inputId}:`, error);
        throw error;
    }
}


// --- Funkcje tworzące zasoby ---
async function createRtmpInput(region, name, inputClass = 'STANDARD', securityGroupId) {
    const credentials = getCredentials();
    const mediaLiveClient = new MediaLiveClient({ region, credentials });
    const destinations = (inputClass === 'STANDARD') 
        ? [{ StreamName: `${name}/a` }, { StreamName: `${name}/b` }]
        : [{ StreamName: `${name}/a` }];
    const params = {
        Name: name,
        Type: 'RTMP_PUSH',
        Destinations: destinations,
        InputSecurityGroups: [securityGroupId],
        Tags: { CreatedBy: 'AWSMediaTool-NodeJS' }
    };
    try {
        const command = new CreateInputCommand(params);
        return await mediaLiveClient.send(command);
    } catch (error) {
        console.error("Error creating RTMP input:", error);
        throw error;
    }
}

async function createMp4Input(region, name, urls) {
    const credentials = getCredentials();
    const mediaLiveClient = new MediaLiveClient({ region, credentials });
    const sources = urls.map(url => ({ Url: url }));
    const params = {
        Name: name,
        Type: 'MP4_FILE',
        Sources: sources,
        Tags: { CreatedBy: 'AWSMediaTool-NodeJS' }
    };
    try {
        const command = new CreateInputCommand(params);
        return await mediaLiveClient.send(command);
    } catch (error) {
        console.error("Error creating MP4 input:", error);
        throw error;
    }
}

async function createChannel(region, channelData) {
    const credentials = getCredentials();
    const mediaLiveClient = new MediaLiveClient({ region, credentials });
    const stsClient = new STSClient({ region, credentials });
    const identity = await stsClient.send(new GetCallerIdentityCommand({}));
    const accountId = identity.AccountId;
    let roleArn = process.env.MEDIALIVE_ROLE_ARN;
    const templateName = channelData.channelClass === 'STANDARD' 
        ? 'standard_pipeline_template.json' 
        : 'single_pipeline_template.json';
    const templatePath = path.join(__dirname, '..', 'templates', templateName);
    const template = JSON.parse(await fs.readFile(templatePath, 'utf-8'));

    // Dynamiczne uzupełnianie szablonu
    template.Name = channelData.channelName;
    template.RoleArn = roleArn;
    template.InputAttachments[0].InputId = channelData.inputId;
    
    if (template.Destinations && template.Destinations[0].MediaPackageSettings) {
        template.Destinations[0].MediaPackageSettings[0].ChannelId = channelData.mediaPackageChannelId;
        
        if (template.EncoderSettings && template.EncoderSettings.OutputGroups && template.EncoderSettings.OutputGroups[0]) {
            template.EncoderSettings.OutputGroups[0].Name = channelData.mediaPackageChannelId;
        }

    } else {
        throw new Error("Szablon JSON nie jest skonfigurowany dla wyjścia MediaPackage.");
    }

    try {
        const command = new CreateChannelCommand(template);
        return await mediaLiveClient.send(command);
    } catch (error) {
        console.error("Error creating channel:", error);
        throw error;
    }
}

async function createLinkInput(region, name, deviceIds) {
    const credentials = getCredentials();
    const mediaLiveClient = new MediaLiveClient({ region, credentials });
    const params = {
        Name: name,
        Type: 'INPUT_DEVICE',
        InputDevices: deviceIds.map(id => ({ Id: id })),
        Tags: { CreatedBy: 'AWSMediaTool-NodeJS' }
    };
    try {
        const command = new CreateInputCommand(params);
        return await mediaLiveClient.send(command);
    } catch (error) {
        console.error("Error creating Link input:", error);
        throw error;
    }
}

async function createMediaConnectInput(region, name, flowArns) {
    const credentials = getCredentials();
    const mediaLiveClient = new MediaLiveClient({ region, credentials });
    const params = {
        Name: name,
        Type: 'MEDIACONNECT',
        MediaConnectFlows: flowArns.map(arn => ({ FlowArn: arn })),
        Tags: { CreatedBy: 'AWSMediaTool-NodeJS' }
    };
    try {
        const command = new CreateInputCommand(params);
        return await mediaLiveClient.send(command);
    } catch (error) {
        console.error("Error creating MediaConnect input:", error);
        throw error;
    }
}

// --- Funkcje do zarządzania i usuwania ---
async function startChannel(region, channelId) {
    const credentials = getCredentials();
    const mediaLiveClient = new MediaLiveClient({ region, credentials });
    try {
        const command = new StartChannelCommand({ ChannelId: channelId });
        return await mediaLiveClient.send(command);
    } catch (error) {
        console.error(`Error starting channel ${channelId}:`, error);
        throw error;
    }
}

async function stopChannel(region, channelId) {
    const credentials = getCredentials();
    const mediaLiveClient = new MediaLiveClient({ region, credentials });
    try {
        const command = new StopChannelCommand({ ChannelId: channelId });
        return await mediaLiveClient.send(command);
    } catch (error) {
        console.error(`Error stopping channel ${channelId}:`, error);
        throw error;
    }
}

async function deleteChannel(region, channelId) {
    const credentials = getCredentials();
    const mediaLiveClient = new MediaLiveClient({ region, credentials });
    try {
        const command = new DeleteChannelCommand({ ChannelId: channelId });
        return await mediaLiveClient.send(command);
    } catch (error) {
        console.error(`Error deleting channel ${channelId}:`, error);
        throw error;
    }
}

async function deleteInput(region, inputId) {
    const credentials = getCredentials();
    const mediaLiveClient = new MediaLiveClient({ region, credentials });
    try {
        const command = new DeleteInputCommand({ InputId: inputId });
        return await mediaLiveClient.send(command);
    } catch (error) {
        console.error(`Error deleting input ${inputId}:`, error);
        throw error;
    }
}

module.exports = {
    getAvailableRegions,
    listChannels,
    listInputs,
    listS3Mp4Assets,
    listInputDevices,
    listInputSecurityGroups,
    listMediaConnectFlows,
    listMediaPackageChannels,
    describeChannel,
    describeInput,
    createRtmpInput,
    createMp4Input,
    createChannel,
    createLinkInput,
    createMediaConnectInput,
    startChannel,
    stopChannel,
    deleteChannel,
    deleteInput,
    generateResourceNames
};
