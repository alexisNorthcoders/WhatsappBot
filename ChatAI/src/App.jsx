import './App.css'
import Footer from '../components/Footer';
import Header from '../components/Header';
import Home from '../components/chat';
import { Container ,Row,Col} from 'react-bootstrap';

function App() {
  

  return (<Container> <Col>
    <Row> <Header/></Row>
   <Row> <Home/></Row>
   <Row><Footer/></Row></Col>
  </Container>
    
  )
}

export default App
