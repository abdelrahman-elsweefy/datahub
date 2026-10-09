package controllers;

import auth.AuthUtils;
import com.fasterxml.jackson.databind.JsonNode;
import com.typesafe.config.Config;
import java.net.URI;
import java.net.URLEncoder;
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
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.inject.Inject;
import play.libs.Json;
import play.mvc.Controller;
import play.mvc.Http;
import play.mvc.Result;

public class QueryServiceController extends Controller {
  private static final int MAX_REQUEST_BYTES = 70000;
  private final HttpClient client;
  private final String endpoint;
  private final String secret;
  private final Semaphore inFlight = new Semaphore(50);

  @Inject
  public QueryServiceController(HttpClient client, Config config) {
    this.client = client;
    this.endpoint = config.getString("queryService.endpoint").replaceAll("/+$", "");
    this.secret = config.getString("queryService.proxySecret");
  }

  public CompletableFuture<Result> connections(Http.Request request, String datasetUrn) {
    if (datasetUrn.length() > 4096) {
      return completed(error(400, "INVALID_DATASET_URN", "The dataset identifier is invalid."));
    }
    String path = "/v1/connections";
    if (!datasetUrn.isEmpty()) {
      path += "?datasetUrn=" + URLEncoder.encode(datasetUrn, StandardCharsets.UTF_8);
    }
    return forward(request, path, new byte[0], true);
  }

  public CompletableFuture<Result> query(Http.Request request) {
    if (!request.contentType().orElse("").equals("application/json")) {
      return completed(error(415, "INVALID_CONTENT_TYPE", "Submit the query as JSON."));
    }
    JsonNode json = request.body().asJson();
    if (json == null) {
      return completed(error(400, "INVALID_REQUEST", "Submit a valid query request."));
    }
    byte[] body = json.toString().getBytes(StandardCharsets.UTF_8);
    if (body.length > MAX_REQUEST_BYTES) {
      return completed(
          error(413, "REQUEST_TOO_LARGE", "The query request exceeds the request limit."));
    }
    return forward(request, "/v1/query", body, true);
  }

  public CompletableFuture<Result> health(Http.Request request) {
    return forward(request, "/health", new byte[0], false);
  }

  private CompletableFuture<Result> forward(
      Http.Request request, String path, byte[] body, boolean authenticated) {
    if (authenticated && !AuthUtils.hasValidSessionCookie(request)) {
      return completed(error(401, "UNAUTHENTICATED", "Sign in to run queries."));
    }
    if (endpoint.isEmpty() || secret.length() < 32) {
      return completed(
          error(503, "QUERY_SERVICE_UNAVAILABLE", "The query service is not configured."));
    }
    if (!inFlight.tryAcquire()) {
      return completed(
          error(429, "QUERY_CAPACITY_REACHED", "The query service is busy. Try again shortly."));
    }
    try {
      URI target = URI.create(endpoint + path);
      if (!"http".equals(target.getScheme()) && !"https".equals(target.getScheme())) {
        throw new IllegalArgumentException("Invalid query service scheme");
      }
      HttpRequest.Builder builder = HttpRequest.newBuilder(target).timeout(Duration.ofSeconds(135));
      String method = body.length == 0 ? "GET" : "POST";
      if (authenticated) {
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
                method,
                signedPath,
                digest(body),
                digest(authorization.getBytes(StandardCharsets.UTF_8)));
        builder
            .header("X-DataHub-Query-Actor", actor)
            .header("X-DataHub-Query-Timestamp", timestamp)
            .header("X-DataHub-Query-Signature", sign(secret, payload))
            .header(Http.HeaderNames.AUTHORIZATION, authorization);
      }
      builder.header(Http.HeaderNames.CONTENT_TYPE, "application/json");
      builder.method(
          method,
          body.length == 0
              ? HttpRequest.BodyPublishers.noBody()
              : HttpRequest.BodyPublishers.ofByteArray(body));
      return client
          .sendAsync(builder.build(), HttpResponse.BodyHandlers.ofByteArray())
          .thenApply(
              response ->
                  status(response.statusCode(), response.body())
                      .as("application/json")
                      .withHeader("Cache-Control", "no-store"))
          .exceptionally(
              failure ->
                  error(503, "QUERY_SERVICE_UNAVAILABLE", "The query service is unavailable."))
          .whenComplete((result, failure) -> inFlight.release());
    } catch (IllegalArgumentException | GeneralSecurityException exception) {
      inFlight.release();
      return completed(
          error(503, "QUERY_SERVICE_UNAVAILABLE", "The query service is unavailable."));
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
