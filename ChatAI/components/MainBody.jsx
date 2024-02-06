import React, { useState } from "react";
import ChatHistory from "./ChatHistory";
import Input from "./Input";
import { Row,Col, Container } from "react-bootstrap";


export default function MainBody() {
  const [submit, setSubmit] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [readingStream, setReadingStream] = useState(true);

  
return ( <Container >
<Col >
  <Row className="chat">
    <ChatHistory setReadingStream={setReadingStream} readingStream={readingStream} inputValue={inputValue} submit={submit}/>
  </Row>
  <Row className="input-container">
    <Input setReadingStream={setReadingStream} submit={submit} setSubmit={setSubmit} setInputValue={setInputValue} inputValue={inputValue}/>
  </Row>
</Col>
</Container>
  );
}
