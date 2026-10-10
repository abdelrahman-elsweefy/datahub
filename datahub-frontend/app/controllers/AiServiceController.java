package controllers;

import auth.AuthUtils;
import com.fasterxml.jackson.databind.JsonNode;
import com.typesafe.config.Config;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Semaphore;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.inject.Inject;
import play.libs.Json;
import play.mvc.Controller;
import play.mvc.Http;
import play.mvc.Result;

public class AiServiceController extends Controller {
  private static final Pattern ALLOWED_PATH =
      Pattern.compile("v1/(ask|conversations(/[0-9a-fA-F-]{36})?)|health|ready");
  private static final int MAX_REQUEST_BYTES = 70000;
  private final HttpClient client;
  private final String endpoint;
  private final String secret;
  private final Semaphore inFlight = new Semaphore(50);

  @Inject
  public AiServiceController(HttpClient client, Config config) {
    this.client = client;
    this.endpoint = config.getString("aiService.endpoint").replaceAll("/+$", "");
    this.secret = config.getString("aiService.proxySecret");
  }

  public CompletableFuture<Result> forward(String path, Http.Request request) {
    if (!AuthUtils.hasValidSessionCookie(request)) {
      return completed(error(401, "UNAUTHENTICATED", "Sign in to use Ask AI."));
    }
    if (!ALLOWED_PATH.matcher(path).matches()) {
      return completed(error(404, "NOT_FOUND", "Assistant endpoint not found."));
    }
    if (endpoint.isEmpty() || secret.length() < 32) {
      return completed(error(503, "AI_UNCONFIGURED", "The assistant is not configured."));
    }
    byte[] body = new byte[0];
    if (request.method().equals("POST") || request.method().equals("PATCH")) {
      JsonNode json = request.body().asJson();
      if (json != null) {
        body = json.toString().getBytes(StandardCharsets.UTF_8);
      } else if (!path.equals("v1/conversations")) {
        return completed(error(400, "INVALID_REQUEST", "Submit a valid assistant request."));
      }
      if (body.length > MAX_REQUEST_BYTES) {
        return completed(
            error(413, "REQUEST_TOO_LARGE", "The assistant request exceeds its size limit."));
      }
    }
    if (!inFlight.tryAcquire()) {
      return completed(error(429, "AI_BUSY", "The assistant is busy. Try again shortly."));
    }
    try {
      String query = URI.create(request.uri()).getRawQuery();
      URI target = URI.create(endpoint + "/" + path + (query == null ? "" : "?" + query));
      if (!target.getScheme().equals("http") && !target.getScheme().equals("https")) {
        throw new IllegalArgumentException("Invalid AI service scheme");
      }
      String actor = request.session().data().get(AuthUtils.ACTOR);
      String authorization =
          "Bearer " + request.session().data().get(AuthUtils.SESSION_COOKIE_GMS_TOKEN_NAME);
      String timestamp = Long.toString(Instant.now().getEpochSecond());
      String signedPath =
          target.getRawPath() + (target.getRawQuery() == null ? "" : "?" + target.getRawQuery());
      String payload =
          String.join(
              "\n",
              timestamp,
              actor,
              request.method(),
              signedPath,
              digest(body),
              digest(authorization.getBytes(StandardCharsets.UTF_8)));
      HttpRequest forward =
          HttpRequest.newBuilder(target)
              .timeout(Duration.ofSeconds(200))
              .header(Http.HeaderNames.CONTENT_TYPE, "application/json")
              .header(Http.HeaderNames.AUTHORIZATION, authorization)
              .header("X-DataHub-AI-Actor", actor)
              .header("X-DataHub-AI-Timestamp", timestamp)
              .header("X-DataHub-AI-Signature", sign(secret, payload))
              .method(
                  request.method(),
                  body.length == 0
                      ? HttpRequest.BodyPublishers.noBody()
                      : HttpRequest.BodyPublishers.ofByteArray(body))
              .build();
      return client
          .sendAsync(forward, HttpResponse.BodyHandlers.ofByteArray())
          .thenApply(
              response ->
                  status(response.statusCode(), response.body())
                      .as("application/json")
                      .withHeader("Cache-Control", "no-store"))
          .exceptionally(
              failure -> error(503, "AI_UNAVAILABLE", "The assistant is temporarily unavailable."))
          .whenComplete((result, failure) -> inFlight.release());
    } catch (IllegalArgumentException | GeneralSecurityException exception) {
      inFlight.release();
      return completed(error(503, "AI_UNAVAILABLE", "The assistant is temporarily unavailable."));
    }
  }

  static String sign(String secret, String payload) throws GeneralSecurityException {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
    return HexFormat.of().formatHex(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)));
  }

  private static String digest(byte[] bytes) throws GeneralSecurityException {
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
  }

  private Result error(int statusCode, String code, String message) {
    return status(statusCode, Json.newObject().put("code", code).put("message", message))
        .withHeader("Cache-Control", "no-store");
  }

  private CompletableFuture<Result> completed(Result result) {
    return CompletableFuture.completedFuture(result);
  }
}
