import {
    TranslateLexPostTextResponse,
    TranslateLexV2PostTextResponse,
    TranslateToLexPostTextRequest,
    TranslateToLexV2PostTextRequest
} from "@xapp/stentor-lex-lib";
import { Lambda, LexRuntime, LexRuntimeV2 } from "aws-sdk";
import { ActiveContext, Request, Response } from "stentor-models";

/**
 * A common Context object for lambdas.
 */
export type AWSApiGatewayLambdaContext = LambdaContext;

export interface LambdaContext {
    callbackWaitsForEmptyEventLoop?: boolean;
    logGroupName?: string;
    logStreamName?: string;
    functionName?: string;
    memoryLimitInMB?: string;
    functionVersion?: number;
    awsRequestId?: string;
    invokedFunctionArn?: string;
}

export const LEX_BOT = process.env.LEX_BOT;
export const LEX_BOT_ID = process.env.LEX_BOT_ID;
export const LEX_BOT_LOCALE = process.env.LEX_BOT_LOCALE;
export const LEX_BOT_VERSION = process.env.LEX_BOT_VERSION;
export const LEX_BOT_ALIAS = process.env.LEX_BOT_ALIAS;
export const LEX_BOT_ALIAS_ID = process.env.LEX_BOT_ALIAS_ID;

export const OCSTUDIO_ARN = process.env.OC_STUDIO_ARN;
const LambdaArnSplit = OCSTUDIO_ARN.split(":");
const OCSTUDIO_NAME = LambdaArnSplit[LambdaArnSplit.length - 1];

export type BaseEvent = Request;

export interface APIGatewayEvent {
    body?: string;
}

export type Event = BaseEvent | APIGatewayEvent;

const lambda = new Lambda();

const lex = new LexRuntime();
const requestTranslator = new TranslateToLexPostTextRequest();
const responseTranslator = new TranslateLexPostTextResponse();

const lexV2 = new LexRuntimeV2();
const requestV2Translator = new TranslateToLexV2PostTextRequest();
const responseV2Translator = new TranslateLexV2PostTextResponse();

export async function handler(event: any, context: LambdaContext) {
    const translatorRequest = getTranslatorRequest(event);

    let sessionId;
    let userId;

    // We only want this request to be handled by PostText if there's an inputText.
    // Otherwise the Studio handler will take care of the request.
    if (LEX_BOT_VERSION === "v2") {
        const lexV2Request = requestV2Translator.translate(translatorRequest);

        // We will need a session id in Lex V2
        sessionId = lexV2Request.sessionId;

        if (lexV2Request.text) {
            console.log(`Recognizing ${lexV2Request.text}`);
            return lexV2.recognizeText({
                ...lexV2Request,
                botId: LEX_BOT_ID,
                botAliasId: LEX_BOT_ALIAS_ID,
                localeId: LEX_BOT_LOCALE,
            }).promise()
                .then((lexResponse: any) => {
                    console.log('Lex Response!');
                    console.log(lexResponse);
                    return responseV2Translator.translate(lexResponse)
                })
                .then((response: any) => {
                    console.log('Response from Translate!');
                    console.log(response);
                    return getHandlerReturnValue(event, response)
                });
        }
    } else {
        const lexRequest = requestTranslator.translate(translatorRequest);

        userId = lexRequest.userId;

        if (lexRequest.inputText) {
            return lex.postText({
                botName: LEX_BOT,
                botAlias: LEX_BOT_ALIAS || "latest",
                userId: "TestUserId",
                ...lexRequest
            }).promise()
                .then((lexResponse: any) => responseTranslator.translate(lexResponse))
                .then((response: any) => getHandlerReturnValue(event, response));
        }
    }

    let response: Response;

    console.log('Invoking the labmda!');
    await lambda.invoke({
        FunctionName: OCSTUDIO_NAME,
        Payload: JSON.stringify(event)
    }).promise().then((result: any) => {
        console.log('Lambda response');
        console.log(result);
        response = JSON.parse(JSON.parse(result.Payload).body) as Response; // Stentor response
    });

    if (response.context) {
        if (LEX_BOT_VERSION === "v2") {
            const putSessionV2Request: LexRuntimeV2.PutSessionRequest = {
                botId: LEX_BOT_ID,
                botAliasId: LEX_BOT_ALIAS_ID,
                localeId: LEX_BOT_LOCALE,
                sessionId,
                sessionState: {
                    activeContexts: convertV2ActiveContext(response.context.active)
                }
            };

            console.log('putting session');
            console.log(putSessionV2Request)
            await lexV2.putSession(putSessionV2Request).promise();
        } else {
            // In Lex V1 the name/alias/user identifies the conversation aka. session
            const putSessionRequest: LexRuntime.PutSessionRequest = {
                botName: LEX_BOT,
                botAlias: LEX_BOT_ALIAS || "latest",
                userId: userId || "TestUserId",
                activeContexts: convertActiveContext(response.context.active)
            };

            await lex.putSession(putSessionRequest).promise();
        }
    }

    return getHandlerReturnValue(event, response);
}

function getHandlerReturnValue(event: Event, response: object): object {
    if (isApiGatewayEvent(event)) {
        return {
            statusCode: 200,
            body: JSON.stringify(response),
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            }
        };
    }
    return response;
}

function getTranslatorRequest(event: Event): Request {
    if (isApiGatewayEvent(event)) {
        try {
            return JSON.parse(event.body);
        } catch (e) {
            console.error("Could not parse body", event.body, e);
            throw new Error("Invalid API Gateway input body.");
        }
    }
    return event;
}

function isApiGatewayEvent(event: Event): event is APIGatewayEvent {
    return !!(event as APIGatewayEvent).body;
}

function convertActiveContext(active: ActiveContext[]): LexRuntime.ActiveContext[] {
    if (!active || active.length === 0) return [];

    return active.map((value, index) => {
        return {
            name: value.name,
            timeToLive: value.timeToLive,
            parameters: value.parameters || {}
        };
    });
}

function convertV2ActiveContext(active: ActiveContext[]): LexRuntimeV2.ActiveContext[] {
    if (!active || active.length === 0) return [];

    return active.map((value, index) => {
        return {
            name: value.name,
            timeToLive: {
                timeToLiveInSeconds: value.timeToLive?.timeToLiveInSeconds,
                turnsToLive: value.timeToLive?.turnsToLive
            },
            contextAttributes: value.parameters || {}
        };
    });
}